// Machine-to-machine transport. A peer is reached either over ssh (runs
// `xmsg remote <op>` there and reads one JSON line back; nothing to open or
// configure beyond ssh itself) or over http with a shared key.
//
// Two ops cross machines: `deliver` (a message for a session over there) and
// `status` (a delivery update for a message that came from over there).
import { spawn } from 'node:child_process'
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export function callPeer(peer, op, payload, timeoutMs = 20000) {
  if (peer.transport === 'ssh') return viaSsh(peer, op, payload, timeoutMs)
  if (peer.transport === 'http') return viaHttp(peer, op, payload, timeoutMs)
  return Promise.reject(new Error(`unknown transport: ${peer.transport}`))
}

function viaSsh(peer, op, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cmd = `${peer.cmd || 'xmsg'} remote ${op}`
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', peer.host, cmd], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { p.kill(); reject(new Error(`ssh ${peer.host} timed out`)) }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => {
      clearTimeout(timer)
      const line = out.trim().split('\n').pop()
      try {
        const res = JSON.parse(line)
        res.error ? reject(new Error(res.error)) : resolve(res)
      } catch { reject(new Error(`ssh ${peer.host} exited ${code}: ${(err || out).trim().slice(-300)}`)) }
    })
    p.stdin.end(JSON.stringify(payload))
  })
}

async function viaHttp(peer, op, payload, timeoutMs) {
  const res = await fetch(new URL(`/v1/${op}`, peer.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) throw new Error(body.error || `http ${res.status}`)
  return body
}

function keyMatches(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// The key identifies the calling machine; `handle(op, payload, machine)` must
// check that payload addresses really belong to that machine.
export function listenHttp(listen, acceptFrom, handle) {
  const [host, port] = listen.includes(':') ? [listen.slice(0, listen.lastIndexOf(':')), Number(listen.slice(listen.lastIndexOf(':') + 1))] : ['127.0.0.1', Number(listen)]
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const m = /^\/v1\/(deliver|status|ls)$/.exec(req.url || '')
    if (req.method !== 'POST' || !m) return reply(404, { error: 'not found' })
    const token = (req.headers.authorization || '').replace(/^Bearer /, '')
    const who = acceptFrom.find(a => token && keyMatches(a.key, token))
    if (!who) return reply(401, { error: 'unknown key' })
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy() })
    req.on('end', async () => {
      try { reply(200, await handle(m[1], JSON.parse(body), who.machine)) } catch (e) { reply(400, { error: e.message }) }
    })
  })
  server.listen(port, host)
  return server
}
