// omp adapter: talks to the socket opened by omp/xmsg-inbox.ts.
import net from 'node:net'
import { join, relative } from 'node:path'
import { readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs'

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function listSessions(ompDir) {
  if (!existsSync(ompDir)) return []
  const out = []
  for (const f of readdirSync(ompDir)) {
    if (!f.endsWith('.json')) continue
    const file = join(ompDir, f)
    let r
    try { r = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    if (!alive(r.pid)) { try { unlinkSync(file) } catch {} continue }
    out.push({ kind: 'omp', name: r.name, id: String(r.pid), pid: r.pid, socket: r.socket, cwd: r.cwd })
  }
  return out
}

// macOS caps a unix socket path at 104 bytes; connect relative to the socket's
// directory when the absolute path is too long.
function connectPath(path) {
  if (Buffer.byteLength(path) < 100) return { path }
  const rel = relative(process.cwd(), path)
  if (Buffer.byteLength(rel) < 100) return { path: rel }
  throw new Error(`socket path too long to connect: ${path}`)
}

export function deliver(session, { id, text }, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(connectPath(session.socket))
    let buf = ''
    let written = false
    const timer = setTimeout(() => { s.destroy(); reject(Object.assign(new Error('omp inbox did not answer'), { maybeDelivered: written })) }, timeoutMs)
    s.setEncoding('utf8')
    s.once('error', e => { clearTimeout(timer); reject(e) })
    s.once('connect', () => { s.write(JSON.stringify({ id, text }) + '\n'); written = true })
    s.on('data', d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      clearTimeout(timer)
      s.end()
      const r = JSON.parse(buf.slice(0, i))
      r.ok ? resolve(r) : reject(new Error(r.error || 'omp inbox refused'))
    })
  })
}
