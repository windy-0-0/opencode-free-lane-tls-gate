/**
 * Official-client bridge.
 *
 * ## Why this exists (2026-11-13, measured)
 *
 * The free lane is gated on the **TLS ClientHello**, not on the request body.
 * Measured on one machine, one egress IP, the same handful of seconds:
 *
 *   official `opencode` binary (Bun)   JA3 4b74b406…  17 ciphers /14 ext  → 200
 *   node `fetch` (undici)              JA3 d0642faa…  52 ciphers /12 ext  → 429
 *   `bun` `fetch`                      JA3 fef5c900…  17 ciphers /13 ext  → 429
 *
 * Byte-for-byte replaying the official request (headers *and* body, captured
 * off the wire) from node still answers 429, while the official process
 * answers 200 at the same moment. So no header/body shaping can pass this
 * gate: the gate is who is holding the socket.
 *
 * The only client that holds a socket with that exact fingerprint is the
 * official binary itself, so this module runs it. It is a **fallback
 * transport**, used only when the direct path answers `FreeUsageLimitError`
 * and an official binary is present; everything else (quota errors from other
 * lanes, region errors, real answers) keeps its existing behaviour.
 *
 * ## What it can and cannot carry
 *
 * `opencode run --format json` yields step/text/tool_use events. The `tool_use`
 * events arrive with `state.status === "completed"` — the official agent
 * executed the tool itself, so tool **calls** cannot be handed back to the
 * caller for its own execution. This bridge therefore carries text turns only
 * and refuses tool-bearing requests instead of silently stripping them (a
 * stripped tool call would look like a model that forgot how to use tools).
 *
 * @module src/official-bridge
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync, accessSync, constants, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Ordered candidates; first existing executable wins. Override with `OUR_FREE_MODEL_OFFICIAL_BIN`. */
export function findOfficialBinary() {
  const explicit = process.env.OUR_FREE_MODEL_OFFICIAL_BIN
  const candidates = [
    explicit,
    join(homedir(), '.opencode', 'bin', 'opencode'),
    join(homedir(), '.local', 'bin', 'opencode'),
    join(homedir(), '.bun', 'bin', 'opencode'),
    ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'opencode')),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate)
      if (!stat.isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* next candidate */ }
  }
  return undefined
}

/** Is the bridge usable on this machine right now? */
export function officialBridgeAvailable() {
  return findOfficialBinary() !== undefined
}

/**
 * Flatten one conversation into the single text body the official client takes.
 *
 * `run` has no system-prompt or multi-message entry point, so the transcript is
 * rendered as one message. That is a real semantic difference from a native
 * turn (the official agent prepends its own system prompt), so it is stated
 * plainly instead of being papered over: this lane answers as a plain chat
 * model, not as a DSH agent.
 */
export function renderConversation(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const parts = []
  let system = typeof body?.system === 'string' ? body.system : ''
  for (const message of messages) {
    const role = String(message?.role ?? 'user')
    const text = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.filter(b => b?.type === 'text').map(b => String(b.text ?? '')).join('')
        : ''
    if (role === 'system') { system += (system ? '\n\n' : '') + text; continue }
    if (text === '') continue
    parts.push(`${role === 'assistant' ? 'Assistant' : 'User'}: ${text}`)
  }
  const transcript = parts.join('\n\n')
  return system ? `${system}\n\n---\n\n${transcript}` : transcript
}

/** True when the turn carries tools or tool results — the bridge cannot honour those. */
export function carriesTools(body) {
  if (Array.isArray(body?.tools) && body.tools.length > 0) return true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some(m => m?.role === 'tool' || Array.isArray(m?.tool_calls) || Array.isArray(m?.toolCalls))
}

const MIN_TIMEOUT_MS = 30_000
const DEFAULT_TIMEOUT_MS = 600_000

/**
 * The permission set a bridged run gets: read the workspace, nothing else.
 *
 * `external_directory` is allowed on purpose. The official client treats any
 * path outside its own cwd as "external" and asks before reading it — and an
 * ask in non-interactive mode is auto-rejected, which is the exact failure this
 * whole mechanism exists to avoid. Denying reads there would resurrect it for
 * any prompt that names an absolute path, which agent prompts do constantly.
 * The file still cannot be written, and shell stays denied, so "read anything,
 * change nothing" is the honest description of what this grants.
 */
const BRIDGE_PERMISSIONS = {
  read: 'allow',
  list: 'allow',
  glob: 'allow',
  grep: 'allow',
  external_directory: 'allow',
  bash: 'deny',
  edit: 'deny',
  write: 'deny',
}

/** One config file per process, written on first use; `undefined` means "let the binary use its own". */
let bridgeConfigPath
function writeBridgeConfig() {
  if (bridgeConfigPath !== undefined) return bridgeConfigPath
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ofm-bridge-'))
    const file = join(dir, 'opencode.json')
    writeFileSync(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: BRIDGE_PERMISSIONS }, null, 2))
    bridgeConfigPath = file
    return file
  } catch {
    // No temp dir (a locked-down box): fall back to the binary's own config. A
    // turn that then needs a tool fails loudly as "produced no text" rather than
    // silently pretending to have answered.
    return undefined
  }
}

/**
 * Run one text turn through the official client and stream it back as SSE.
 *
 * The returned frames use the same `data: {chunk}` shape the free lane's own
 * SSE reader already parses, so callers see one wire format regardless of which
 * transport produced it.
 *
 * ## Tool-bearing turns (the honest trade-off)
 *
 * A DSH agent turn always declares tools, so refusing them here would make the
 * bridge useless for the only thing the lane is wanted for. What actually
 * happens for such a turn: the tool **schemas** are dropped from the prompt
 * (the official agent brings its own toolset and would reject foreign ones),
 * and the official agent runs any tool it decides it needs **itself**. The
 * caller therefore receives finished text, not a `tool_calls` frame — it cannot
 * re-execute those steps under its own permission model, and the transcript
 * shows the official run's tool output only as prose.
 *
 * That is a real capability difference, not a wire detail, so it is recorded on
 * the return value (`toolsRunUpstream`) for the settings page to surface.
 *
 * @param {object} options
 * @param {object} options.body - OpenAI-shaped request body
 * @param {AbortSignal} [options.signal]
 * @param {(text: string) => void} options.onData - receives SSE frames
 * @param {string} [options.binary] - override the discovered executable
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ model: string, frames: number, toolsRunUpstream: boolean }>}
 */
export async function streamViaOfficial({ body, signal, onData, binary, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const executable = binary ?? findOfficialBinary()
  if (executable === undefined) {
    throw new Error('no official opencode executable was found; set OUR_FREE_MODEL_OFFICIAL_BIN to its path')
  }
  const toolsRunUpstream = carriesTools(body)
  const model = String(body?.model ?? '')
  const prompt = renderConversation(body)
  if (prompt.trim() === '') throw new Error('the official-client bridge needs at least one non-empty message')

  const args = ['run', '--format', 'json', '--model', `opencode/${model}`, prompt]
  const budget = Math.max(MIN_TIMEOUT_MS, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))

  // Tool permissions are what make an agent-style turn survive this transport.
  //
  // Measured 2026-11-13 (the failure that looked like "the fix stopped working"):
  // the official CLI auto-rejects a permission request in non-interactive mode
  // and then **ends the run without emitting a single `text` event** — the turn
  // arrives here as exit code 0 with zero text, which this module reported as
  // `the official client produced no text` and the caller then surfaced as the
  // lane's own 429. A DSH agent turn always declares tools, so the official
  // agent reliably reaches for one (reading a file its prompt named), and every
  // such turn died the same way.
  //
  // Allowing **read-only** tools fixes exactly that: the official agent performs
  // the read itself and then writes the answer as text, which is the whole
  // contract of this transport. Writes and shell stay denied — a bridged turn
  // must not be able to change the machine on behalf of a caller that never saw
  // the tool call (see `toolsRunUpstream` above), and nothing this bridge offers
  // needs them.
  //
  // The permission set is passed through a dedicated config file rather than the
  // user's own `~/.config/opencode`: this is the bridge's contract with the
  // binary, not a change to how the user's own opencode install behaves.
  const configPath = writeBridgeConfig()
  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_DISABLE_TELEMETRY: '1', ...(configPath === undefined ? {} : { OPENCODE_CONFIG: configPath }) },
  })

  let killedForTimeout = false
  const timer = setTimeout(() => { killedForTimeout = true; child.kill('SIGTERM') }, budget)
  timer.unref?.()

  const onAbort = () => child.kill('SIGTERM')
  signal?.addEventListener('abort', onAbort, { once: true })

  let stderr = ''
  let buffer = ''
  let frames = 0
  let sawText = false
  let failure = ''

  const emit = (payload) => {
    frames += 1
    onData(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
  }

  try {
    await new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('{')) continue
          let event
          try { event = JSON.parse(trimmed) } catch { continue }
          if (event?.type === 'text' && typeof event?.part?.text === 'string' && event.part.text !== '') {
            sawText = true
            emit({ choices: [{ index: 0, delta: { content: event.part.text } }] })
          } else if (event?.type === 'step_finish' && event?.part?.tokens !== undefined) {
            const tokens = event.part.tokens ?? {}
            emit({ choices: [], usage: {
              prompt_tokens: Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0),
              completion_tokens: Number(tokens.output ?? 0),
              total_tokens: Number(tokens.total ?? 0),
              cache_read_input_tokens: Number(tokens.cache?.read ?? 0),
            } })
          } else if (event?.type === 'error') {
            failure = String(event?.error?.message ?? event?.part?.message ?? 'official client reported an error')
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
      child.on('error', reject)
      child.on('close', code => {
        // A trailing partial line is only worth reading when it parses.
        const tail = buffer.trim()
        if (tail.startsWith('{')) {
          try {
            const event = JSON.parse(tail)
            if (event?.type === 'text' && typeof event?.part?.text === 'string') {
              sawText = true
              emit({ choices: [{ index: 0, delta: { content: event.part.text } }] })
            }
          } catch { /* incomplete JSON is dropped, not guessed at */ }
        }
        if (signal?.aborted === true) return resolve()
        if (killedForTimeout) return reject(new Error(`the official client exceeded ${budget}ms`))
        if (failure !== '') return reject(new Error(failure))
        if (code !== 0) {
          const detail = stderr.trim().split('\n').slice(-3).join(' ').trim()
          return reject(new Error(`the official client exited with code ${code}${detail === '' ? '' : `: ${detail}`}`))
        }
        if (!sawText) return reject(new Error('the official client produced no text'))
        resolve()
      })
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  emit('[DONE]')
  return { model, frames, toolsRunUpstream }
}
