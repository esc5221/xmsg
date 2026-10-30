// Codex adapter: JSON-RPC to the shared local app-server daemon over its
// control socket (WebSocket on a unix path). A busy thread gets the message
// steered into its active turn; an idle thread gets a new turn tagged
// turnTrigger "xmsg". Never pass approvalPolicy / sandboxPolicy here: those
// persist into the user's later turns.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { UnixWebSocket } from '../ws.js'

export function controlSocketPath(env = process.env) {
  const home = env.CODEX_HOME || join(homedir(), '.codex')
  return join(home, 'app-server-control', 'app-server-control.sock')
}

export class CodexRpc {
  static async open({ path = controlSocketPath(), timeoutMs = 5000 } = {}) {
    if (!existsSync(path)) throw new Error(`codex app-server daemon socket not found: ${path}`)
    const ws = await UnixWebSocket.connect(path, { timeoutMs })
    const rpc = new CodexRpc(ws, timeoutMs)
    await rpc.call('initialize', { clientInfo: { name: 'xmsg', version: '0.1.0' } })
    rpc.notify('initialized')
    return rpc
  }

  constructor(ws, timeoutMs) {
    this.ws = ws
    this.timeoutMs = timeoutMs
    this.id = 0
    this.pending = new Map()
    ws.on('message', text => {
      let m
      try { m = JSON.parse(text) } catch { return }
      if (m.id == null || !this.pending.has(m.id)) return
      const { resolve, reject, timer } = this.pending.get(m.id)
      clearTimeout(timer)
      this.pending.delete(m.id)
      if (m.error) reject(Object.assign(new Error(m.error.message || 'codex rpc error'), { rpc: m.error }))
      else resolve(m.result)
    })
    ws.on('close', () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('codex rpc closed')) }
      this.pending.clear()
    })
  }

  call(method, params) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`codex rpc ${method} timed out`), { timeout: true })) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notify(method, params) { this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params && { params }) })) }

  close() { this.ws.close() }
}

async function withRpc(fn, opts) {
  const rpc = await CodexRpc.open(opts)
  try { return await fn(rpc) } finally { rpc.close() }
}

// Threads currently loaded in the daemon — the ones a message can reach now.
export function listThreads(opts) {
  return withRpc(async rpc => {
    const ids = []
    let cursor
    do {
      const page = await rpc.call('thread/loaded/list', { ...(cursor && { cursor }), limit: 100 })
      ids.push(...page.data.map(t => (typeof t === 'string' ? t : t.id)))
      cursor = page.nextCursor
    } while (cursor)
    const out = []
    for (const id of ids) {
      try {
        const { thread } = await rpc.call('thread/read', { threadId: id, includeTurns: false })
        out.push({ id, name: thread.name || null, cwd: thread.cwd || null, status: thread.status?.type || 'unknown', ephemeral: !!thread.ephemeral })
      } catch {}
    }
    return out
  }, opts)
}

// Returns { via: 'steer'|'start', turnId }. A timeout on steer/start is
// flagged maybeDelivered: the daemon may have accepted it before answering.
export function deliver(threadId, text, { clientMessageId, ...opts } = {}) {
  return withRpc(async rpc => {
    const input = [{ type: 'text', text, text_elements: [] }]
    const ids = clientMessageId ? { clientUserMessageId: clientMessageId } : {}
    const sent = p => p.catch(e => { if (e.timeout) e.maybeDelivered = true; throw e })
    const { thread } = await rpc.call('thread/read', { threadId, includeTurns: true })
    const active = thread.status?.type === 'active' ? thread.turns?.findLast(t => t.status === 'inProgress') : null
    if (active) {
      try {
        const r = await sent(rpc.call('turn/steer', { threadId, expectedTurnId: active.id, input, ...ids }))
        return { via: 'steer', turnId: r.turnId }
      } catch (e) {
        if (e.maybeDelivered) throw e
        // The turn ended between read and steer: fall through and start a new one.
      }
    }
    const r = await sent(rpc.call('turn/start', { threadId, input, turnTrigger: 'xmsg', ...ids }))
    return { via: 'start', turnId: r.turn?.id }
  }, opts)
}
