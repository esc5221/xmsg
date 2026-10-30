// Who is reachable on this machine right now. Nothing registers with xmsg
// except omp; Claude and Codex sessions are read from their own state.
import { userInfo } from 'node:os'
import * as claude from './adapters/claude.js'
import * as codex from './adapters/codex.js'
import * as omp from './adapters/omp.js'
import { parseAddress } from './address.js'

export async function listLocal(cfg, paths) {
  const sessions = [...claude.listSessions(cfg.claudeConfigDirs), ...omp.listSessions(paths.ompDir)]
  let codexError = null
  try {
    for (const t of await codex.listThreads({ timeoutMs: 3000 })) {
      if (t.ephemeral) continue
      sessions.push({ kind: 'codex', name: t.name || `codex-${t.id.slice(-8)}`, id: t.id, cwd: t.cwd, status: t.status })
    }
  } catch (e) { codexError = e.message }
  return { sessions, codexError }
}

// Current name first, then id prefix or suffix (6+ chars), then a name the
// session had earlier: Claude and Codex rename sessions mid-conversation, and
// peers keep using the address they were given. `formerIds(kind, name)` comes
// from the daemon's name history. Several matches is an error the caller
// shows with the candidates.
export function resolve(sessions, addr, formerIds) {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  const pool = a.kind ? sessions.filter(s => s.kind === a.kind) : sessions
  let hits = pool.filter(s => s.name === a.name)
  const key = a.name.replace(/^(claude|codex)-(?=[0-9a-f-]{6,}$)/, '')
  if (!hits.length && key.length >= 6) hits = pool.filter(s => s.id.startsWith(key) || s.id.endsWith(key))
  if (!hits.length && formerIds) {
    const ids = formerIds(a.kind, a.name)
    hits = pool.filter(s => ids.includes(s.id))
  }
  if (hits.length === 1) return { session: hits[0] }
  if (hits.length > 1) return { ambiguous: hits }
  return { missing: true }
}

export function addressOf(cfg, s) {
  return `${cfg.machine}/${s.kind}:${s.name}`
}

// An address that survives renames: the session id (a Claude id's start, a
// Codex thread id's end, since v7 ids share their leading timestamp). omp
// sessions have no id beyond their pid, so they keep their name.
export function stableAddress(cfg, s) {
  if (s.kind === 'claude') return `${cfg.machine}/claude:${s.id.slice(0, 8)}`
  if (s.kind === 'codex') return `${cfg.machine}/codex:${s.id.slice(-12)}`
  return addressOf(cfg, s)
}

// Names close to a missing one, for the error message.
export function similar(sessions, addr) {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  const n = a.name.toLowerCase()
  return sessions.filter(s => (!a.kind || s.kind === a.kind) && (s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()))).slice(0, 5)
}

// Who is running `xmsg`: each agent exports something its tool shells inherit.
// Most specific first: a codex or omp started from a Claude shell still
// carries CLAUDE_CODE_SESSION_ID.
export function callerAddress(cfg, sessions, env = process.env) {
  return caller(cfg, sessions, env).address
}

// Same caller, as { address, replyTo }: the readable address, and the one a
// reply should go to so it still arrives after the caller is renamed.
export function caller(cfg, sessions, env = process.env) {
  const named = address => ({ address, replyTo: address })
  if (env.XMSG_FROM) {
    const a = parseAddress(env.XMSG_FROM)
    return named(`${a.machine || cfg.machine}/${a.kind || 'cli'}:${a.name}`)
  }
  if (env.CODEX_THREAD_ID) {
    const s = sessions.find(x => x.kind === 'codex' && x.id === env.CODEX_THREAD_ID)
    return { address: `${cfg.machine}/codex:${s ? s.name : 'codex-' + env.CODEX_THREAD_ID.slice(-8)}`, replyTo: `${cfg.machine}/codex:${env.CODEX_THREAD_ID.slice(-12)}` }
  }
  if (env.XMSG_SELF) {
    const a = parseAddress(env.XMSG_SELF)
    return named(`${cfg.machine}/${a.kind || 'cli'}:${a.name}`)
  }
  if (env.CLAUDE_CODE_SESSION_ID) {
    const s = sessions.find(x => x.kind === 'claude' && x.id === env.CLAUDE_CODE_SESSION_ID)
    return { address: s ? addressOf(cfg, s) : `${cfg.machine}/claude:claude-${env.CLAUDE_CODE_SESSION_ID.slice(0, 8)}`, replyTo: `${cfg.machine}/claude:${env.CLAUDE_CODE_SESSION_ID.slice(0, 8)}` }
  }
  return named(`${cfg.machine}/cli:${userInfo().username}`)
}
