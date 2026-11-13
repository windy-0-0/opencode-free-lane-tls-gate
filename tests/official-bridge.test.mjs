/**
 * Offline checks for the official-client bridge (src/official-bridge.js).
 *
 * These assert the parts that must not depend on the network: binary
 * discovery, the transcript rendering, the tool-bearing flag, and the abort
 * path. The live behaviour (that upstream accepts the official socket's TLS
 * fingerprint and refuses ours) is measured separately and is recorded in the
 * module header.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const mod = join(here, '..', 'src', 'official-bridge.js')
const { findOfficialBinary, carriesTools, renderConversation, streamViaOfficial } = await import(mod)

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`ok   ${name}`) }
  catch (error) { console.log(`FAIL ${name}\n     ${error.message}`); process.exitCode = 1 }
}

check('renderConversation puts the system prompt ahead of the transcript', () => {
  const prompt = renderConversation({
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  })
  assert.ok(prompt.startsWith('You are terse.'), 'system prompt must lead')
  assert.ok(prompt.includes('User: hi'), 'user turn must be rendered')
  assert.ok(prompt.includes('Assistant: hello'), 'assistant turn must be rendered')
})

check('renderConversation folds a system role message into the system text', () => {
  const prompt = renderConversation({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'x' }] })
  assert.ok(prompt.startsWith('Be brief.'), 'a system-role message must not be rendered as a turn')
  assert.ok(prompt.includes('User: x'))
})

check('renderConversation reads text blocks out of array content', () => {
  const prompt = renderConversation({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }] })
  assert.equal(prompt, 'User: ab')
})

check('carriesTools is true for declared tools', () => {
  assert.equal(carriesTools({ tools: [{ type: 'function' }] }), true)
  assert.equal(carriesTools({ tools: [] }), false)
  assert.equal(carriesTools({}), false)
})

check('carriesTools is true for a tool result or a tool_calls history row', () => {
  assert.equal(carriesTools({ messages: [{ role: 'tool', content: 'x' }] }), true)
  assert.equal(carriesTools({ messages: [{ role: 'assistant', tool_calls: [] }] }), true)
  assert.equal(carriesTools({ messages: [{ role: 'user', content: 'x' }] }), false)
})

check('findOfficialBinary honours OUR_FREE_MODEL_OFFICIAL_BIN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofm-bridge-'))
  const fake = join(dir, 'opencode')
  writeFileSync(fake, '#!/bin/sh\nexit 0\n')
  chmodSync(fake, 0o755)
  const previous = process.env.OUR_FREE_MODEL_OFFICIAL_BIN
  process.env.OUR_FREE_MODEL_OFFICIAL_BIN = fake
  try { assert.equal(findOfficialBinary(), fake) }
  finally {
    if (previous === undefined) delete process.env.OUR_FREE_MODEL_OFFICIAL_BIN
    else process.env.OUR_FREE_MODEL_OFFICIAL_BIN = previous
  }
})

check('findOfficialBinary skips a path that does not exist', () => {
  const previous = process.env.OUR_FREE_MODEL_OFFICIAL_BIN
  process.env.OUR_FREE_MODEL_OFFICIAL_BIN = join(tmpdir(), 'definitely-not-here-8f3a', 'opencode')
  try { assert.notEqual(findOfficialBinary(), process.env.OUR_FREE_MODEL_OFFICIAL_BIN) }
  finally {
    if (previous === undefined) delete process.env.OUR_FREE_MODEL_OFFICIAL_BIN
    else process.env.OUR_FREE_MODEL_OFFICIAL_BIN = previous
  }
})

check('an explicitly missing binary is reported, not silently replaced', async () => {
  const missing = join(tmpdir(), 'definitely-not-here-8f3a', 'opencode')
  await assert.rejects(
    () => streamViaOfficial({ body: { model: 'm', messages: [{ role: 'user', content: 'x' }] }, onData: () => {}, binary: missing }),
    /no official opencode executable|ENOENT/,
  )
})

check('an empty conversation is refused before a process is spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofm-bridge-'))
  const fake = join(dir, 'opencode')
  writeFileSync(fake, '#!/bin/sh\nexit 0\n')
  chmodSync(fake, 0o755)
  await assert.rejects(
    () => streamViaOfficial({ body: { model: 'm', messages: [] }, onData: () => {}, binary: fake }),
    /at least one non-empty message/,
  )
})

console.log(`\n${passed} checks passed`)
