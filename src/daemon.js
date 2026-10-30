// xmsgd: one per machine. Owns the message store, the Claude reply sockets
// and the machine-to-machine transport. The CLI only talks to this process,
// because Claude answers (receipts, SendMessage replies) only the process that
// wrote the frame.
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { ensureHome, loadConfig } from './config.js'
import { Store, FINAL } from './store.js'
import { serve } from './rpc.js'
import { parseAddress, displayName } from './address.js'
import { claudeEnvelope, parseClaudeEnvelope, peerNotice } from './envelope.js'
import { listLocal, resolve, addressOf, stableAddress, similar, caller, callerAddress } from './registry.js'
import * as claude from './adapters/claude.js'
import * as codex from './adapters/codex.js'
import * as omp from './adapters/omp.js'
import { callPeer, listenHttp } from './remote.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const PAIR_LIMIT = 20 // messages per sender→target pair per minute
const CONFIRM_WINDOW_MS = 30 * 60 * 1000
const NAME_SCAN_MS = 30 * 1000 // how often idle daemons record session names
const log = (...a) => console.log(new Date().toISOString(), ...a)

// A peer may only run remote-* ops, with the fields those ops read. The
// machine comes from the transport (http key / ssh login), never the payload.
export function remoteRequest(op, payload, machine) {
  if (!['deliver', 'status', 'ls'].includes(op)) throw new Error(`unknown remote op ${op}`)
  const { id, from, replyTo, to, body, status, detail } = payload || {}
  return { id, from, replyTo, to, body, status, detail, op: `remote-${op}`, machine }
}

export class Daemon {
  constructor(env = process.env) {
    this.env = env
    this.paths = ensureHome(env)
    this.cfg = loadConfig(env)
    this.store = new Store(this.paths.db)
    this.hub = new claude.ReplyHub((remote, frame) => this.onClaudeLine(remote, frame))
    this.inflight = new Set()
    this.lastTry = new Map()
    this.cache = { at: 0, value: null }
    this.pairs = new Map() // "from→to" → recent send timestamps
  }

  overLimit(from, to) {
    const key = `${from}→${to}`, now = Date.now()
    const recent = (this.pairs.get(key) || []).filter(t => now - t < 60000)
    recent.push(now)
    this.pairs.set(key, recent)
    return recent.length > PAIR_LIMIT
  }

  async start() {
    if (existsSync(this.paths.control)) unlinkSync(this.paths.control)
    this.control = serve(this.paths.control, req => this.handle(req))
    writeFileSync(this.paths.pid, String(process.pid))
    if (this.cfg.listen) {
      this.http = listenHttp(this.cfg.listen, this.cfg.acceptFrom, (op, payload, machine) => this.handle(remoteRequest(op, payload, machine)))
      log('http listening on', this.cfg.listen)
    }
    this.timer = setInterval(() => this.retry().catch(e => log('retry error', e.message)), 3000)
    log(`xmsgd up · machine ${this.cfg.machine} · pid ${process.pid}`)
  }

  stop() {
    clearInterval(this.timer)
    this.control?.close()
    this.http?.close()
    this.hub.closeAll()
    try { unlinkSync(this.paths.control) } catch {}
    try { unlinkSync(this.paths.pid) } catch {}
    this.store.close()
  }

  async sessions(fresh = false) {
    if (fresh || Date.now() - this.cache.at > 1000) {
      this.cache = { at: Date.now(), value: await listLocal(this.cfg, this.paths) }
      this.store.rememberNames(this.cache.value.sessions)
    }
    return this.cache.value
  }

  find(sessions, addr) {
    return resolve(sessions, addr, (kind, name) => this.store.formerIds(kind, name))
  }

  async handle(req) {
    switch (req.op) {
      case 'ping': return { ok: true, machine: this.cfg.machine, pid: process.pid }
      case 'ls': {
        const { sessions, codexError } = await this.sessions(true)
        return { machine: this.cfg.machine, sessions: sessions.map(s => ({ ...s, address: addressOf(this.cfg, s) })), codexError, peers: Object.keys(this.cfg.peers) }
      }
      case 'whoami': return { address: callerAddress(this.cfg, (await this.sessions()).sessions, req.env || {}) }
      case 'send': {
        const { sessions } = await this.sessions()
        const me = caller(this.cfg, sessions, req.env || {})
        return this.submit({ from: me.address, replyTo: me.replyTo, to: req.to, body: req.body })
      }
      case 'show': {
        const m = this.store.get(req.id) || this.store.find(req.id)
        if (!m) throw new Error(`no message ${req.id}`)
        return { message: m, events: this.store.events(m.id) }
      }
      case 'log': return { messages: this.store.recent(req.limit || 30) }
      case 'approve': case 'deny': {
        const m = this.store.get(req.id) || this.store.find(req.id)
        if (!m) throw new Error(`no message ${req.id}`)
        if (m.status !== 'held' || m.via !== 'xmsg-hold') throw new Error(`${m.id.slice(0, 8)} is not held by xmsg (status ${m.status})`)
        if (req.op === 'deny') return { message: this.update(m.id, 'denied', { detail: 'denied on this machine' }) }
        this.update(m.id, 'queued', { detail: 'approved on this machine' })
        await this.attempt(this.store.get(m.id))
        return { message: this.store.get(m.id) }
      }
      case 'inbox': {
        const { sessions } = await this.sessions()
        const me = req.address || callerAddress(this.cfg, sessions, req.env || {})
        return { address: me, messages: this.store.recent(500).filter(m => m.to_addr === me).slice(0, req.limit || 20) }
      }
      case 'remote-deliver': {
        const from = parseAddress(req.from)
        if (from.machine !== req.machine) throw new Error(`sender ${req.from} is not on ${req.machine}`)
        let replyTo = null
        try { if (req.replyTo && parseAddress(req.replyTo).machine === req.machine) replyTo = req.replyTo } catch {}
        const existing = this.store.get(req.id)
        if (existing) return { status: existing.status, detail: existing.detail }
        return this.submit({ id: req.id, from: req.from, replyTo, to: req.to, body: req.body, origin: req.machine })
      }
      // What a peer machine may see: addresses and status, no paths.
      case 'remote-ls': {
        const { sessions } = await this.sessions(true)
        return { machine: this.cfg.machine, sessions: sessions.map(s => ({ address: addressOf(this.cfg, s), kind: s.kind, status: s.status || null })) }
      }
      case 'ls-peers': {
        const out = []
        await Promise.all(Object.entries(this.cfg.peers).map(async ([name, peer]) => {
          try { out.push({ machine: name, ...(await callPeer(peer, 'ls', { machine: this.cfg.machine }, 15000)) }) } catch (e) { out.push({ machine: name, error: e.message }) }
        }))
        return { peers: out }
      }
      case 'remote-status': {
        const m = this.store.get(req.id)
        if (!m) return { ok: false }
        if (parseAddress(m.to_addr).machine !== req.machine) throw new Error('status from a machine that does not hold the target')
        this.update(m.id, req.status, { detail: req.detail })
        return { ok: true }
      }
      default: throw new Error(`unknown op ${req.op}`)
    }
  }

  // Normalize the target, store the message, make the first delivery attempt.
  async submit({ id, from, replyTo = null, to, body, origin = 'local' }) {
    if (!body || !String(body).trim()) throw new Error('empty message')
    const a = parseAddress(to)
    let target = { machine: a.machine || this.cfg.machine, kind: a.kind, name: a.name }
    let toId = null, missing = null
    if (target.machine === this.cfg.machine && target.kind !== 'cli' && target.kind !== 'ttym') {
      const { sessions, codexError } = await this.sessions(true)
      const r = this.find(sessions, target)
      if (r.ambiguous) throw new Error(`${to} matches several sessions: ${r.ambiguous.map(s => `${stableAddress(this.cfg, s)} (${s.name})`).join(', ')}. Send to one of those addresses.`)
      if (r.session) {
        target = { machine: this.cfg.machine, kind: r.session.kind, name: r.session.name }
        toId = r.session.id
      } else if (!(codexError && (!target.kind || target.kind === 'codex'))) {
        // Nothing by that name now or before. Say so at once rather than
        // retrying for an hour while the sender assumes it arrived. (If the
        // Codex daemon could not be asked, the thread may well exist: retry.)
        const near = similar(sessions, target).map(s => addressOf(this.cfg, s))
        missing = `no ${target.kind ? target.kind + ' ' : ''}session named ${target.name} on ${this.cfg.machine}${near.length ? `; similar: ${near.join(', ')}` : ''} (xmsg ls lists them)`
      }
    }
    const toAddr = `${target.machine}/${target.kind ? target.kind + ':' : ''}${target.name}`
    const msg = this.store.create({ id, from, to: toAddr, body: String(body), origin, toId, replyTo: replyTo && replyTo !== from ? replyTo : null })
    log('message', msg.id.slice(0, 8), from, '→', toAddr)
    // Two agents told to "answer via xmsg" can answer each other forever, and
    // Codex/omp (unlike Claude) do not throttle peers themselves.
    if (missing) {
      this.update(msg.id, 'failed', { detail: missing })
    } else if (this.overLimit(from, toAddr)) {
      this.update(msg.id, 'failed', { detail: `rate limited: more than ${PAIR_LIMIT} messages from ${from} to ${toAddr} in a minute` })
    } else if (this.needsHold(msg, target)) {
      this.update(msg.id, 'held', { via: 'xmsg-hold', detail: `from another machine; run: xmsg approve ${msg.id.slice(0, 8)}` })
    } else await this.attempt(msg)
    const cur = this.store.get(msg.id)
    return { id: cur.id, from: cur.from_addr, to: cur.to_addr, status: cur.status, detail: cur.detail, via: cur.via }
  }

  // Codex and omp take injected text as if the user typed it, and often run
  // without approvals. Text from another machine waits for a local yes unless
  // that peer is marked trusted. Claude applies its own holds.
  needsHold(msg, target) {
    if (msg.origin === 'local' || target.machine !== this.cfg.machine) return false
    if (!['codex', 'omp', 'ttym'].includes(target.kind)) return false
    return this.cfg.peers[msg.origin]?.trust !== 'deliver'
  }

  update(id, status, opts = {}) {
    const before = this.store.get(id)
    const m = this.store.setStatus(id, status, opts)
    if (!m || before?.status === m.status && before?.detail === m.detail) return m
    log('status', id.slice(0, 8), status, opts.detail || '')
    // Tell the machine the message came from.
    if (m.origin !== 'local' && this.cfg.peers[m.origin]) {
      callPeer(this.cfg.peers[m.origin], 'status', { machine: this.cfg.machine, id, status: m.status, detail: m.detail }).catch(e => log('status push failed', m.origin, e.message))
    }
    return m
  }

  async attempt(msg) {
    if (this.inflight.has(msg.id)) return
    this.inflight.add(msg.id)
    this.lastTry.set(msg.id, Date.now())
    this.store.bumpAttempt(msg.id)
    try {
      const to = parseAddress(msg.to_addr)
      if (to.machine !== this.cfg.machine) return await this.toPeer(msg, to.machine)
      if (to.kind === 'cli') return this.update(msg.id, 'delivered', { via: 'inbox', detail: 'stored for xmsg inbox' })
      if (to.kind === 'ttym') return await this.toTtym(msg, to.name)
      const s = await this.targetSession(msg, to)
      if (!s) return
      const notice = peerNotice({ id: msg.id, from: msg.from_addr, replyTo: msg.reply_to, body: msg.body })
      if (s.kind === 'claude') return await this.toClaude(msg, s)
      if (s.kind === 'codex') {
        const res = await codex.deliver(s.id, notice, { clientMessageId: msg.id })
        return this.update(msg.id, 'delivered', { via: `codex:${res.via}`, detail: `turn ${res.turnId}` })
      }
      if (s.kind === 'omp') {
        await omp.deliver(s, { id: msg.id, text: notice })
        return this.update(msg.id, 'delivered', { via: 'omp' })
      }
    } catch (e) {
      log('attempt failed', msg.id.slice(0, 8), e.message)
      // A timeout after the request went out may still have delivered it;
      // retrying would inject it twice.
      if (e.maybeDelivered) this.update(msg.id, 'sent', { detail: `unconfirmed: ${e.message}` })
      else this.update(msg.id, 'queued', { detail: `retrying: ${e.message}` })
    } finally {
      this.inflight.delete(msg.id)
    }
  }

  // The session a message is for. Once the target resolved at send time, the
  // message stays bound to that session id: a rename does not lose it, and a
  // new session that later takes the name does not receive it.
  async targetSession(msg, to) {
    const { sessions } = await this.sessions(true)
    if (msg.to_id) {
      const s = sessions.find(x => x.id === msg.to_id)
      if (!s) this.update(msg.id, 'queued', { detail: `session ${msg.to_id.slice(0, 8)} is not running; retrying` })
      return s || null
    }
    const r = this.find(sessions, to)
    if (r.ambiguous) { this.update(msg.id, 'failed', { detail: `several sessions match: ${r.ambiguous.map(s => stableAddress(this.cfg, s)).join(', ')}` }); return null }
    if (!r.session) { this.update(msg.id, 'queued', { detail: 'no such session yet; retrying' }); return null }
    return r.session
  }

  async toClaude(msg, s) {
    // Answers go to reply_to (id-based) when there is one, so they still
    // arrive after the sender is renamed. The socket path stays keyed by the
    // readable address so existing reply sockets keep their paths.
    const replySocket = claude.replySocketPath(s.socket, msg.from_addr)
    await this.hub.ensure(replySocket, msg.reply_to || msg.from_addr)
    const content = claudeEnvelope({ from: `uds:${replySocket}`, fromName: displayName(msg.from_addr), body: msg.body })
    await claude.writeFrame(s.socket, claude.buildFrame({ msgId: msg.id, sessionId: s.id, replySocket, content }))
    this.update(msg.id, 'sent', { via: 'claude', detail: `written to ${s.socket}` })
    // Direct delivery sends no receipt; the transcript shows the peer turn with our msg_id.
    for (let i = 0; i < 20; i++) {
      await sleep(300)
      const cur = this.store.get(msg.id)
      if (cur.status !== 'sent') return
      if (claude.transcriptHasMessage(s, msg.id)) return this.update(msg.id, 'delivered', { detail: 'seen in transcript' })
    }
  }

  async toTtym(msg, addr) {
    // Fallback for panes without a native inbox: type it in. One line, because
    // a newline in a TUI input submits early.
    const text = peerNotice({ id: msg.id, from: msg.from_addr, replyTo: msg.reply_to, body: msg.body }).replace(/\s*\n\s*/g, ' / ')
    const run = args => new Promise((res, rej) => {
      const p = spawn('ttym', args, { stdio: 'ignore' })
      p.on('error', rej)
      p.on('close', code => (code === 0 ? res() : rej(new Error(`ttym ${args[0]} exited ${code}`))))
    })
    await run(['send', addr, '--', text])
    await sleep(300)
    await run(['send', addr, '--', '\r'])
    this.update(msg.id, 'sent', { via: 'ttym', detail: 'typed into the pane; no delivery signal' })
  }

  async toPeer(msg, machine) {
    const peer = this.cfg.peers[machine]
    if (!peer) return this.update(msg.id, 'failed', { detail: `unknown machine ${machine}; add it with xmsg peer add` })
    const res = await callPeer(peer, 'deliver', { machine: this.cfg.machine, id: msg.id, from: msg.from_addr, replyTo: msg.reply_to, to: msg.to_addr, body: msg.body })
    const status = res.status === 'queued' ? 'sent' : res.status
    this.update(msg.id, status, { via: `peer:${machine}`, detail: res.detail ? `${machine}: ${res.detail}` : null })
  }

  // A line on a reply socket: a receipt for something we sent to Claude, or the
  // Claude session answering `remote` with SendMessage.
  async onClaudeLine(remote, frame) {
    const status = claude.receiptStatus(frame)
    if (status) {
      if (frame.orig_msg_id && this.store.get(frame.orig_msg_id)) this.update(frame.orig_msg_id, status, { detail: frame.reason || null })
      return
    }
    if (frame.type !== 'user') return
    const content = typeof frame.message?.content === 'string' ? frame.message.content : ''
    const env = parseClaudeEnvelope(content)
    const body = env ? env.body : content
    const sock = (frame.from || '').replace(/^uds:/, '')
    const { sessions } = await this.sessions(true)
    const s = sessions.find(x => x.kind === 'claude' && x.socket === sock)
    const from = s ? addressOf(this.cfg, s) : `${this.cfg.machine}/claude:${env?.attrs['from-name'] || 'unknown'}`
    log('reply from', from, '→', remote)
    this.submit({ from, replyTo: s ? stableAddress(this.cfg, s) : null, to: remote, body }).catch(e => log('reply routing failed', e.message))
  }

  async retry() {
    const now = Date.now()
    if (now - this.cache.at > NAME_SCAN_MS) await this.sessions(true)
    // A busy Claude session queues the message and writes the peer turn (with
    // our msg_id) only when it gets to it, so keep looking for a while.
    const waiting = this.store.unconfirmed(now - CONFIRM_WINDOW_MS)
    if (waiting.length) {
      const { sessions } = await this.sessions()
      for (const m of waiting) {
        const s = m.to_id ? sessions.find(x => x.id === m.to_id) : this.find(sessions, parseAddress(m.to_addr)).session
        if (s?.kind === 'claude' && claude.transcriptHasMessage(s, m.id)) this.update(m.id, 'delivered', { detail: 'seen in transcript' })
      }
    }
    for (const m of this.store.pending()) {
      if (this.inflight.has(m.id)) continue
      if (now - m.created > this.cfg.retryTtlSec * 1000) { this.update(m.id, 'expired', { detail: 'never reached the target' }); continue }
      if (now - (this.lastTry.get(m.id) || 0) < 5000) continue
      this.attempt(m)
    }
  }
}

export { FINAL }
