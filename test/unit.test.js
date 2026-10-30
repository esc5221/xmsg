import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAddress, formatAddress, displayName } from '../src/address.js'
import { claudeEnvelope, parseClaudeEnvelope, peerNotice } from '../src/envelope.js'
import { encodeFrame, decodeFrames } from '../src/ws.js'
import { Store } from '../src/store.js'
import { resolve, callerAddress, caller, stableAddress } from '../src/registry.js'
import { replySocketPath, receiptStatus, buildFrame, transcriptPath } from '../src/adapters/claude.js'

test('addresses parse with optional machine and kind', () => {
  assert.deepEqual(parseAddress('build'), { machine: null, kind: null, name: 'build' })
  assert.deepEqual(parseAddress('desktop/claude:review'), { machine: 'desktop', kind: 'claude', name: 'review' })
  assert.deepEqual(parseAddress('ttym:xmsg-lab:omp'), { machine: null, kind: 'ttym', name: 'xmsg-lab:omp' })
  // an unknown prefix before ':' is part of the name
  assert.deepEqual(parseAddress('ws:name'), { machine: null, kind: null, name: 'ws:name' })
  assert.equal(formatAddress(parseAddress('desktop/omp:x')), 'desktop/omp:x')
  assert.throws(() => parseAddress('desktop/'))
})

test('display names avoid characters Claude rewrites', () => {
  assert.equal(displayName('laptop/codex:build'), 'laptop-codex-build')
  assert.equal(displayName('laptop/claude:review bot'), 'laptop-claude-review-bot')
})

// The pattern Claude Code 2.1.312 uses to accept an envelope (attribute order
// and framing); it re-serializes and compares, so ours must match exactly.
const CLAUDE_ENVELOPE = /^<cross-session-message(?: from="([^"]+)")?(?: from-session="([^"]+)")?(?: hop-chain="([^"]+)")?(?: from-name="([^"<>\n\r]+)")?(?: from-mode="([a-zA-Z]+)")?(?: from-plugin="([^"<>\n\r]+)")?>\n([\s\S]*)\n<\/cross-session-message>$/

test('claude envelope is canonical', () => {
  const e = claudeEnvelope({ from: 'uds:/tmp/cc-socks/xm-abc.sock', fromName: 'desktop-codex-x"<y>', body: 'line1\nline2' })
  const m = CLAUDE_ENVELOPE.exec(e)
  assert.ok(m, e)
  assert.equal(m[1], 'uds:/tmp/cc-socks/xm-abc.sock')
  assert.equal(m[4], 'desktop-codex-xy')
  assert.equal(m[7], 'line1\nline2')
  const p = parseClaudeEnvelope(e)
  assert.equal(p.body, 'line1\nline2')
  assert.equal(p.attrs['from-name'], 'desktop-codex-xy')
})

test('parses envelopes Claude itself writes', () => {
  const real = '<cross-session-message from="uds:/tmp/cc-socks/14645.sock" hop-chain="c3a85b761507cc7881bb2e26" from-name="xmsg-lab-a9" from-mode="prompting">\nREPLY-VIA-SENDMESSAGE\n</cross-session-message>'
  const p = parseClaudeEnvelope(real)
  assert.equal(p.body, 'REPLY-VIA-SENDMESSAGE')
  assert.equal(p.attrs.from, 'uds:/tmp/cc-socks/14645.sock')
})

test('peer notice names the sender and how to answer', () => {
  const t = peerNotice({ id: '0123456789', from: 'desktop/claude:a', body: 'hello' })
  assert.match(t, /Message from desktop\/claude:a/)
  assert.match(t, /xmsg send desktop\/claude:a/)
  assert.ok(t.endsWith('---\nhello'))
})

test('websocket frames round-trip, masked and fragmented', () => {
  const big = Buffer.alloc(70000, 'a')
  const frames = Buffer.concat([encodeFrame(0x1, Buffer.from('hi')), encodeFrame(0x1, big)])
  const { frames: out, rest } = decodeFrames(frames)
  assert.equal(out.length, 2)
  assert.equal(out[0].payload.toString(), 'hi')
  assert.equal(out[1].payload.length, 70000)
  assert.equal(rest.length, 0)
  const half = decodeFrames(frames.subarray(0, 10))
  assert.equal(half.frames.length, 1)
  assert.ok(half.rest.length > 0)
})

test('store keeps a status trail and ignores late downgrades', () => {
  const s = new Store(join(mkdtempSync(join(tmpdir(), 'xmsg-')), 'm.db'))
  const m = s.create({ from: 'a/cli:x', to: 'a/claude:y', body: 'b' })
  s.setStatus(m.id, 'sent')
  s.setStatus(m.id, 'held')
  s.setStatus(m.id, 'delivered')
  s.setStatus(m.id, 'queued') // late retry must not reopen a delivered message
  assert.equal(s.get(m.id).status, 'delivered')
  assert.deepEqual(s.events(m.id).map(e => e.status), ['queued', 'sent', 'held', 'delivered'])
  assert.equal(s.find(m.id.slice(0, 6)).id, m.id)
  s.close()
})

const SESSIONS = [
  { kind: 'claude', name: 'api', id: '93b422db-15fa-4280-9626-ac84ea48d424' },
  { kind: 'codex', name: 'api', id: '01a18055-65b7-7b41-b116-d64ccbddfce3' },
  { kind: 'omp', name: 'lab-omp', id: '83496' },
]

test('resolve by name, kind and id prefix', () => {
  assert.ok(resolve(SESSIONS, 'api').ambiguous)
  assert.equal(resolve(SESSIONS, 'codex:api').session.kind, 'codex')
  assert.equal(resolve(SESSIONS, '93b422db').session.kind, 'claude')
  assert.ok(resolve(SESSIONS, 'nope').missing)
})

test('caller identity prefers the most specific variable', () => {
  const cfg = { machine: 'm' }
  assert.equal(callerAddress(cfg, SESSIONS, { CLAUDE_CODE_SESSION_ID: SESSIONS[0].id }), 'm/claude:api')
  // codex launched from a Claude shell carries both
  assert.equal(callerAddress(cfg, SESSIONS, { CLAUDE_CODE_SESSION_ID: SESSIONS[0].id, CODEX_THREAD_ID: SESSIONS[1].id }), 'm/codex:api')
  assert.equal(callerAddress(cfg, SESSIONS, { XMSG_SELF: 'omp:lab-omp', CLAUDE_CODE_SESSION_ID: SESSIONS[0].id }), 'm/omp:lab-omp')
  assert.equal(callerAddress(cfg, SESSIONS, { XMSG_FROM: 'bot' }), 'm/cli:bot')
})

test('claude reply sockets stay short and stable per sender', () => {
  const a = replySocketPath('/tmp/cc-socks/14645.sock', 'desktop/codex:x')
  assert.equal(a, replySocketPath('/tmp/cc-socks/99.sock', 'desktop/codex:x'))
  assert.notEqual(a, replySocketPath('/tmp/cc-socks/99.sock', 'desktop/codex:y'))
  assert.ok(Buffer.byteLength(a) < 104)
})

test('claude frames and receipts', () => {
  const f = buildFrame({ msgId: 'id1', sessionId: 's1', replySocket: '/tmp/cc-socks/xm-1.sock', content: 'c' })
  assert.equal(f.from, 'uds:/tmp/cc-socks/xm-1.sock')
  assert.equal(f.msg_id, 'id1')
  assert.equal(receiptStatus({ type: 'control', action: 'peer_message_status', status: 'held' }), 'held')
  assert.equal(receiptStatus({ type: 'control', action: 'peer_message_status', status: 'expired', status_detail: 'refused' }), 'refused')
  assert.equal(receiptStatus({ type: 'user' }), null)
})

test('transcript path follows Claude project naming', () => {
  const p = transcriptPath({ configDir: '/h/.claude', cwd: '/private/tmp/a_b.c', id: 'sid' })
  assert.equal(p, '/h/.claude/projects/-private-tmp-a-b-c/sid.jsonl')
})

test('resolve follows renames through name history, and finds default names by id', () => {
  const lead = { kind: 'claude', name: 'verify-worker-accounts', id: '5e7a1c90-0000-4000-8000-000000000001' }
  const worker = { kind: 'codex', name: 'w1', id: '019a2b3c-0000-7000-8000-6fe973da1234' }
  const sessions = [lead, worker]
  const history = (kind, name) => (name === 'lead-7' && kind !== 'codex' ? [lead.id] : [])
  assert.equal(resolve(sessions, 'claude:lead-7', history).session, lead)
  assert.equal(resolve(sessions, 'lead-7', history).session, lead)
  assert.ok(resolve(sessions, 'claude:lead-7').missing)
  // current name wins over history
  assert.equal(resolve(sessions, 'w1', () => [lead.id]).session, worker)
  // the fallback names callers get when their session is not listed
  assert.equal(resolve(sessions, 'codex:codex-da1234').session, worker)
  assert.equal(resolve(sessions, 'claude:claude-5e7a1c90').session, lead)
  // stable addresses resolve back to the same session
  const cfg = { machine: 'm' }
  assert.equal(stableAddress(cfg, lead), 'm/claude:5e7a1c90')
  assert.equal(stableAddress(cfg, worker), 'm/codex:6fe973da1234')
  assert.equal(resolve(sessions, parseAddress(stableAddress(cfg, lead))).session, lead)
  assert.equal(resolve(sessions, parseAddress(stableAddress(cfg, worker))).session, worker)
})

test('caller carries an id-based reply address', () => {
  const cfg = { machine: 'm' }
  const s = [{ kind: 'claude', name: 'lead', id: '5e7a1c90-0000-4000-8000-000000000001' }]
  assert.deepEqual(caller(cfg, s, { CLAUDE_CODE_SESSION_ID: s[0].id }), { address: 'm/claude:lead', replyTo: 'm/claude:5e7a1c90' })
  assert.deepEqual(caller(cfg, [], { CODEX_THREAD_ID: '019a2b3c-0000-7000-8000-6fe973da1234' }), { address: 'm/codex:codex-73da1234', replyTo: 'm/codex:6fe973da1234' })
  assert.deepEqual(caller(cfg, [], { XMSG_FROM: 'bob' }), { address: 'm/cli:bob', replyTo: 'm/cli:bob' })
  const t = peerNotice({ id: '0123456789', from: 'm/claude:lead', replyTo: 'm/claude:5e7a1c90', body: 'hi' })
  assert.match(t, /Message from m\/claude:lead/)
  assert.match(t, /xmsg send m\/claude:5e7a1c90/)
})

test('store remembers every name a session had', () => {
  const st = new Store(join(mkdtempSync(join(tmpdir(), 'xm-')), 'db'))
  st.rememberNames([{ kind: 'claude', name: 'lead-7', id: 'A' }])
  st.rememberNames([{ kind: 'claude', name: 'verify', id: 'A' }])
  assert.deepEqual(st.formerIds('claude', 'lead-7'), ['A'])
  assert.deepEqual(st.formerIds(null, 'lead-7'), ['A'])
  assert.deepEqual(st.formerIds('codex', 'lead-7'), [])
  const m = st.create({ from: 'a', to: 'b', body: 'x', toId: 'A', replyTo: 'm/claude:A' })
  assert.equal(m.to_id, 'A')
  assert.equal(m.reply_to, 'm/claude:A')
})
