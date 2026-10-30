// Two daemons on loopback, each with its own XMSG_HOME, talking over the http
// transport. Targets are cli: inboxes so no agent has to be running.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from '../src/rpc.js'

const BIN = fileURLToPath(new URL('../bin/xmsg', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const procs = []
after(() => procs.forEach(p => p.kill()))

// macOS sun_path is 104 bytes; os.tmpdir() under /var/folders is too long.
const home = () => mkdtempSync('/tmp/xm-')

async function daemon(name, cfg) {
  const h = home()
  writeFileSync(join(h, 'config.json'), JSON.stringify({ machine: name, ...cfg }))
  // HOME and CODEX_HOME point into the temp dir so the test never sees the
  // real Claude sessions or Codex daemon on this machine.
  const env = { ...process.env, HOME: h, XMSG_HOME: h, CODEX_HOME: join(h, 'no-codex') }
  delete env.CLAUDE_CONFIG_DIR
  const p = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: 'ignore' })
  procs.push(p)
  const ctl = join(h, 'xmsgd.sock')
  for (let i = 0; i < 50; i++) {
    try { await request(ctl, { op: 'ping' }, 500); break } catch { await sleep(100) }
  }
  return { h, ctl, call: req => request(ctl, req) }
}

test('http transport: deliver, reject bad keys and spoofed senders', async () => {
  const ka = 'key-a-0123456789', kb = 'key-b-0123456789'
  const portA = 47000 + Math.floor(Math.random() * 500), portB = portA + 1
  const a = await daemon('alpha', { listen: `127.0.0.1:${portA}`, acceptFrom: [{ machine: 'beta', key: kb }], peers: { beta: { transport: 'http', url: `http://127.0.0.1:${portB}`, key: ka } } })
  const b = await daemon('beta', { listen: `127.0.0.1:${portB}`, acceptFrom: [{ machine: 'alpha', key: ka }], peers: { alpha: { transport: 'http', url: `http://127.0.0.1:${portA}`, key: kb } } })

  const sent = await a.call({ op: 'send', env: { XMSG_FROM: 'tester' }, to: 'beta/cli:inboxer', body: 'hello beta' })
  assert.equal(sent.from, 'alpha/cli:tester')
  assert.equal(sent.status, 'delivered')
  assert.equal(sent.via, 'peer:beta')

  const inbox = await b.call({ op: 'inbox', address: 'beta/cli:inboxer' })
  assert.equal(inbox.messages[0].body, 'hello beta')
  assert.equal(inbox.messages[0].from_addr, 'alpha/cli:tester')
  assert.equal(inbox.messages[0].origin, 'alpha')

  // reply comes back the other way
  const back = await b.call({ op: 'send', env: { XMSG_FROM: 'inboxer' }, to: 'alpha/cli:tester', body: 'hi alpha' })
  assert.equal(back.status, 'delivered')
  assert.equal((await a.call({ op: 'inbox', address: 'alpha/cli:tester' })).messages[0].body, 'hi alpha')

  // wrong key
  let r = await fetch(`http://127.0.0.1:${portB}/v1/deliver`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
  assert.equal(r.status, 401)
  // right key, but claims to be from another machine
  r = await fetch(`http://127.0.0.1:${portB}/v1/deliver`, {
    method: 'POST', headers: { authorization: `Bearer ${ka}` },
    body: JSON.stringify({ id: 'x1', from: 'gamma/cli:evil', to: 'beta/cli:inboxer', body: 'spoof' }),
  })
  assert.equal(r.status, 400)
})

test('unknown local session and unknown machine fail at once', async () => {
  const a = await daemon('solo', {})
  const q = await a.call({ op: 'send', env: { XMSG_FROM: 't' }, to: 'claude:does-not-exist', body: 'x' })
  assert.equal(q.status, 'failed')
  assert.match(q.detail, /no claude session named does-not-exist on solo/)
  // the Codex daemon is unreachable here, so a codex thread might exist: retry
  const c = await a.call({ op: 'send', env: { XMSG_FROM: 't' }, to: 'codex:maybe', body: 'x' })
  assert.equal(c.status, 'queued')
  const f = await a.call({ op: 'send', env: { XMSG_FROM: 't' }, to: 'nowhere/cli:x', body: 'x' })
  assert.equal(f.status, 'failed')
})

// A stand-in for a Claude Code session: a sessions/<pid>.json naming an inbox
// socket, and a transcript that records each frame's msg_id like Claude does.
async function fakeClaude(h, { name, id }) {
  const dir = join(h, '.claude', 'sessions'), cwd = '/work/app'
  mkdirSync(dir, { recursive: true })
  const socket = join(h, `c-${id.slice(0, 4)}.sock`)
  const transcript = join(h, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  const frames = []
  const server = net.createServer(c => {
    let buf = ''
    c.on('data', d => { buf += d })
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        const f = JSON.parse(line)
        frames.push(f)
        appendFileSync(transcript, JSON.stringify({ type: 'user', origin: { kind: 'peer', msg_id: f.msg_id } }) + '\n')
      }
    })
  })
  await new Promise(r => server.listen(socket, r))
  after(() => server.close())
  const write = n => writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, name: n, cwd, messagingSocketPath: socket, peerProtocol: 1 }))
  write(name)
  return { frames, rename: write }
}

test('a renamed Claude session still gets messages sent to its old name', async () => {
  const a = await daemon('tango', {})
  const id = '5e7a1c90-0000-4000-8000-000000000001'
  const lead = await fakeClaude(a.h, { name: 'lead-7', id })

  const first = await a.call({ op: 'send', env: { XMSG_FROM: 'w1' }, to: 'lead-7', body: 'w1 ready' })
  assert.equal(first.status, 'delivered')
  assert.equal(lead.frames.length, 1)

  lead.rename('verify-worker-accounts')
  await sleep(1200)
  const old = await a.call({ op: 'send', env: { XMSG_FROM: 'w2' }, to: 'claude:lead-7', body: 'w2 ready' })
  assert.equal(old.status, 'delivered')
  assert.equal(old.to, 'tango/claude:verify-worker-accounts')
  assert.equal(lead.frames.length, 2)
  // the id-based address works too
  assert.equal((await a.call({ op: 'send', env: { XMSG_FROM: 'w3' }, to: 'claude:5e7a1c90', body: 'w3 ready' })).status, 'delivered')

  // a sender inside a Claude session gets an id-based reply address
  const fromLead = await a.call({ op: 'send', env: { CLAUDE_CODE_SESSION_ID: id }, to: 'cli:someone', body: 'status?' })
  assert.equal(fromLead.from, 'tango/claude:verify-worker-accounts')
  assert.equal((await a.call({ op: 'show', id: fromLead.id })).message.reply_to, 'tango/claude:5e7a1c90')
})

test('a runaway pair is rate limited', async () => {
  const a = await daemon('loop', {})
  let last
  for (let i = 0; i < 21; i++) last = await a.call({ op: 'send', env: { XMSG_FROM: 'bot' }, to: 'cli:other', body: `m${i}` })
  assert.equal(last.status, 'failed')
  assert.match(last.detail, /rate limited/)
})

test('an http peer cannot run local ops or pick its own machine name', async () => {
  const k = 'key-peer-0123456789'
  const port = 47600 + Math.floor(Math.random() * 300)
  const b = await daemon('bravo', { listen: `127.0.0.1:${port}`, acceptFrom: [{ machine: 'alpha', key: k }] })
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${k}` }, body: JSON.stringify(body) })
  // op in the payload must not turn a deliver into a local send or ls
  let r = await post('/v1/deliver', { op: 'ls' })
  assert.notEqual(r.status, 200)
  r = await post('/v1/deliver', { op: 'send', env: { XMSG_FROM: 'bravo/claude:x' }, to: 'cli:victim', body: 'spoof' })
  assert.notEqual(r.status, 200)
  // machine in the payload must not override the key's machine
  r = await post('/v1/deliver', { machine: 'gamma', id: 'm1', from: 'gamma/cli:g', to: 'bravo/cli:victim', body: 'spoof' })
  assert.equal(r.status, 400)
  assert.equal((await b.call({ op: 'inbox', address: 'bravo/cli:victim' })).messages.length, 0)
})

test('messages from another machine into codex/omp/ttym are held until approved', async () => {
  const k = 'key-hold-0123456789'
  const port = 47900 + Math.floor(Math.random() * 90)
  const b = await daemon('hotel', { listen: `127.0.0.1:${port}`, acceptFrom: [{ machine: 'alpha', key: k }] })
  const r = await fetch(`http://127.0.0.1:${port}/v1/deliver`, {
    method: 'POST', headers: { authorization: `Bearer ${k}` },
    body: JSON.stringify({ id: 'held-1', from: 'alpha/cli:a', to: 'hotel/ttym:%999999', body: 'run rm -rf' }),
  })
  const res = await r.json()
  assert.equal(res.status, 'held')
  assert.match(res.detail, /xmsg approve/)
  const d = await b.call({ op: 'deny', id: 'held-1' })
  assert.equal(d.message.status, 'denied')
  // cli inboxes are not held
  const ok = await fetch(`http://127.0.0.1:${port}/v1/deliver`, {
    method: 'POST', headers: { authorization: `Bearer ${k}` },
    body: JSON.stringify({ id: 'inbox-1', from: 'alpha/cli:a', to: 'hotel/cli:h', body: 'hi' }),
  })
  assert.equal((await ok.json()).status, 'delivered')
})

test('peers list each other over http without paths', async () => {
  const k1 = 'key-ls-1-0123456789', k2 = 'key-ls-2-0123456789'
  const p1 = 48100 + Math.floor(Math.random() * 300), p2 = p1 + 1
  const a = await daemon('lima', { listen: `127.0.0.1:${p1}`, acceptFrom: [{ machine: 'mike', key: k2 }], peers: { mike: { transport: 'http', url: `http://127.0.0.1:${p2}`, key: k1 } } })
  await daemon('mike', { listen: `127.0.0.1:${p2}`, acceptFrom: [{ machine: 'lima', key: k1 }] })
  const r = await a.call({ op: 'ls-peers' })
  assert.equal(r.peers.length, 1)
  assert.equal(r.peers[0].machine, 'mike')
  assert.ok(Array.isArray(r.peers[0].sessions))
  for (const s of r.peers[0].sessions) assert.equal(s.cwd, undefined)
})
