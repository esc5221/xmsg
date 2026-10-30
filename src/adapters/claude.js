// Claude Code adapter.
//
// Every running session with cross-session messaging writes
// <configDir>/sessions/<pid>.json naming its inbox socket. xmsg writes one JSON
// line to that socket. The frame's `from` is a reply socket owned by the xmsg
// daemon, one per remote sender, so:
//   - Claude sends peer_message_status receipts (held, delivered, denied, ...) there
//   - the receiving Claude can answer with its own SendMessage tool, and the
//     daemon knows which sender that answer belongs to by the socket it hit.
// Claude only answers the process that sent the frame (it checks the peer pid),
// so frames must be written by the daemon process that owns the reply sockets.
import net from 'node:net'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'

export function claudeConfigDirs(extra = [], env = process.env) {
  const dirs = new Set([join(homedir(), '.claude')])
  if (env.CLAUDE_CONFIG_DIR) dirs.add(env.CLAUDE_CONFIG_DIR)
  // ccx slot homes: each is a separate CLAUDE_CONFIG_DIR with its own sessions/
  const ccx = join(homedir(), '.ccx', 'homes')
  if (existsSync(ccx)) for (const d of readdirSync(ccx)) dirs.add(join(ccx, d))
  for (const d of extra) dirs.add(d)
  return [...dirs].filter(d => existsSync(join(d, 'sessions')))
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function listSessions(extraDirs = []) {
  const out = []
  for (const configDir of claudeConfigDirs(extraDirs)) {
    const dir = join(configDir, 'sessions')
    for (const f of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue
      let s
      try { s = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
      if (!s.messagingSocketPath || s.peerProtocol !== 1 || !alive(s.pid)) continue
      out.push({
        kind: 'claude',
        name: s.name || `claude-${s.sessionId.slice(0, 8)}`,
        id: s.sessionId,
        pid: s.pid,
        socket: s.messagingSocketPath,
        cwd: s.cwd,
        configDir,
        status: s.status || null,
      })
    }
  }
  return out
}

// Reply sockets live next to the target's own socket: Claude only accepts a
// reply address inside its socket directory. Short names keep the path under
// the 104-byte sun_path limit on macOS.
export function replySocketPath(targetSocket, remoteAddr) {
  return join(dirname(targetSocket), `xm-${createHash('sha256').update(remoteAddr).digest('hex').slice(0, 12)}.sock`)
}

export function buildFrame({ msgId, sessionId, replySocket, content }) {
  return { type: 'user', message: { role: 'user', content }, priority: 'next', from: `uds:${replySocket}`, msg_id: msgId, session_id: sessionId }
}

export function writeFrame(socketPath, frame, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: socketPath })
    let written = false
    const timer = setTimeout(() => { s.destroy(); reject(Object.assign(new Error(`timed out writing to ${socketPath}`), { maybeDelivered: written })) }, timeoutMs)
    s.once('error', e => { clearTimeout(timer); reject(Object.assign(e, { maybeDelivered: written })) })
    s.once('connect', () => { s.end(JSON.stringify(frame) + '\n'); written = true })
    s.once('close', () => { clearTimeout(timer); resolve() })
  })
}

// One unix server per remote sender. Each line on it is either a receipt for
// a message we sent or a new message from the Claude session back to `remote`.
export class ReplyHub {
  constructor(onLine) {
    this.onLine = onLine // (remoteAddr, frame) => void
    this.servers = new Map() // path → { server, remote }
  }

  ensure(path, remote) {
    const cur = this.servers.get(path)
    if (cur) return Promise.resolve(path)
    return new Promise((resolve, reject) => {
      try { if (existsSync(path)) unlinkSync(path) } catch {}
      const server = net.createServer(conn => {
        let buf = ''
        conn.setEncoding('utf8')
        conn.on('data', d => {
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1)
            if (!line.trim()) continue
            let frame
            try { frame = JSON.parse(line) } catch { continue }
            if (frame.type === 'auth') continue
            try { this.onLine(remote, frame) } catch {}
            // Claude waits for the close before it reports the send as done.
            conn.end()
          }
        })
        conn.on('error', () => {})
      })
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        this.servers.set(path, { server, remote })
        resolve(path)
      })
    })
  }

  closeAll() {
    for (const [path, { server }] of this.servers) { server.close(); try { unlinkSync(path) } catch {} }
    this.servers.clear()
  }
}

// Receipt statuses Claude reports → xmsg statuses.
export function receiptStatus(frame) {
  if (frame.type !== 'control' || frame.action !== 'peer_message_status') return null
  if (frame.status === 'expired' && frame.status_detail === 'refused') return 'refused'
  return ['held', 'delivered', 'denied', 'expired', 'refused', 'dropped'].includes(frame.status) ? frame.status : null
}

// Claude names a project dir after its cwd with every non-alphanumeric → '-'.
export function transcriptPath(session) {
  return join(session.configDir, 'projects', session.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session.id}.jsonl`)
}

function tail(file, bytes = 256 * 1024) {
  const size = statSync(file).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally { closeSync(fd) }
}

// A directly delivered message produces no receipt; the transcript shows it as
// a peer turn whose origin carries our msg_id.
export function transcriptHasMessage(session, msgId) {
  const file = transcriptPath(session)
  if (!existsSync(file)) return false
  return tail(file).includes(`"msg_id":"${msgId}"`)
}
