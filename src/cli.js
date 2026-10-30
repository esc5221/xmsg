import { spawn } from 'node:child_process'
import { openSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ensureHome, loadConfig, saveConfig } from './config.js'
import { request } from './rpc.js'
import { FINAL } from './store.js'

const BIN = fileURLToPath(new URL('../bin/xmsg', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Identity hints the daemon turns into the caller's address.
const ID_VARS = ['XMSG_FROM', 'CODEX_THREAD_ID', 'XMSG_SELF', 'CLAUDE_CODE_SESSION_ID']
const callerEnv = () => Object.fromEntries(ID_VARS.filter(k => process.env[k]).map(k => [k, process.env[k]]))

export async function daemonCall(req, { autostart = true } = {}) {
  const p = ensureHome()
  try { return await request(p.control, req) } catch (e) {
    if (!autostart || !['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e
  }
  const out = openSync(p.log, 'a')
  spawn(process.execPath, [BIN, 'daemon'], { detached: true, stdio: ['ignore', out, out] }).unref()
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    try { await request(p.control, { op: 'ping' }, 1000); return await request(p.control, req) } catch {}
  }
  throw new Error(`xmsgd did not start; see ${p.log}`)
}

const ago = ts => {
  const s = Math.round((Date.now() - ts) / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

function table(rows) {
  if (!rows.length) return ''
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i] ?? '').length)))
  return rows.map(r => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n')
}

// --flag, --flag=value, or (takesValue) --flag value
function flag(args, name, takesValue = false) {
  const i = args.findIndex(a => a === name || a.startsWith(name + '='))
  if (i < 0) return undefined
  const a = args.splice(i, 1)[0]
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1)
  if (takesValue && i < args.length) return args.splice(i, 1)[0]
  return true
}

const HELP = `xmsg — messages between running agent sessions (Claude Code, Codex, omp)

  xmsg send <to> <message…>     send; "-" reads the message from stdin
        --wait[=sec]            wait until delivered/held/failed (default 20s)
  xmsg ls [--all]               sessions on this machine (--all: and on every peer machine)
  xmsg whoami                   the address replies to you go to
  xmsg inbox                    messages addressed to you (humans/scripts: cli:<user>)
  xmsg log [-n N]               recent messages and their status
  xmsg show <id>                one message with its full status trail
  xmsg approve|deny <id>        release or drop a message held here (from another machine into Codex/omp)
  xmsg peer add <machine> ssh <host> [--cmd=<remote xmsg command>] [--trust]
  xmsg peer add <machine> http <url> <key> [--trust]
                                --trust: deliver that machine's messages into Codex/omp without asking
  xmsg peer ls | rm <machine>
  xmsg key                      print a new key for the http transport
  xmsg accept <machine> <key>   let <machine> deliver here over http with <key>
  xmsg config [<key> [<value>]] machine · listen · retryTtlSec
  xmsg daemon | start | stop | status
  xmsg service install|uninstall  keep xmsgd resident (launchd / systemd user)
  xmsg mcp                      MCP server (stdio) exposing send/ls/inbox/show

addresses: [machine/][claude:|codex:|omp:|ttym:|cli:]name   e.g. build, desktop/claude:review, ttym:%12`

export async function main(argv) {
  const [cmd, ...args] = argv
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': return console.log(HELP)

    case 'send': {
      let wait = flag(args, '--wait')
      const [to, ...rest] = args
      if (!to || !rest.length) throw new Error('usage: xmsg send <to> <message…>')
      const body = rest.length === 1 && rest[0] === '-' ? readFileSync(0, 'utf8') : rest.join(' ')
      let r = await daemonCall({ op: 'send', env: callerEnv(), to, body })
      if (wait) {
        const until = Date.now() + (wait === true ? 20 : Number(wait)) * 1000
        while (!FINAL.has(r.status) && r.status !== 'held' && Date.now() < until) {
          await sleep(500)
          r = { ...r, ...(await daemonCall({ op: 'show', id: r.id })).message }
        }
      }
      console.log(`${r.id.slice(0, 8)}  ${r.from_addr || r.from} → ${r.to_addr || r.to}  ${r.status}${r.detail ? `  (${r.detail})` : ''}`)
      if (['failed', 'refused', 'denied', 'dropped', 'expired'].includes(r.status)) process.exitCode = 1
      return
    }

    case 'ls': {
      const all = flag(args, '--all')
      const r = await daemonCall({ op: 'ls' })
      const rows = [['ADDRESS', 'ID', 'STATUS', 'CWD']]
      for (const s of r.sessions) rows.push([s.address, s.id.slice(0, 8), s.status || '', s.cwd || ''])
      console.log(table(rows))
      if (r.codexError) console.log(`\ncodex: ${r.codexError}`)
      if (!all) {
        if (r.peers.length) console.log(`\npeers: ${r.peers.join(', ')}  (xmsg ls --all lists their sessions too)`)
        return
      }
      for (const p of (await daemonCall({ op: 'ls-peers' })).peers) {
        console.log(`\n${p.machine}${p.error ? `: unreachable (${p.error})` : ''}`)
        if (!p.error) console.log(table([['ADDRESS', 'STATUS'], ...p.sessions.map(s => [s.address, s.status || ''])]))
      }
      return
    }

    case 'whoami': return console.log((await daemonCall({ op: 'whoami', env: callerEnv() })).address)

    case 'inbox': {
      const r = await daemonCall({ op: 'inbox', env: callerEnv() })
      if (!r.messages.length) return console.log(`no messages for ${r.address}`)
      for (const m of r.messages.reverse()) console.log(`── ${m.id.slice(0, 8)} · ${ago(m.created)} ago · from ${m.from_addr}\n${m.body}\n`)
      return
    }

    case 'log': {
      const n = Number(flag(args, '-n', true) || 30)
      const r = await daemonCall({ op: 'log', limit: n })
      const rows = [['ID', 'AGE', 'FROM', 'TO', 'STATUS', 'VIA']]
      for (const m of r.messages) rows.push([m.id.slice(0, 8), ago(m.created), m.from_addr, m.to_addr, m.status, m.via || ''])
      return console.log(table(rows))
    }

    case 'show': {
      const r = await daemonCall({ op: 'show', id: args[0] })
      const m = r.message
      console.log(`${m.id}\n${m.from_addr} → ${m.to_addr}\nstatus ${m.status}${m.detail ? ` (${m.detail})` : ''} · via ${m.via || '-'} · attempts ${m.attempts}\n`)
      for (const e of r.events) console.log(`  ${new Date(e.ts).toISOString().slice(11, 23)}  ${e.status}${e.detail ? `  ${e.detail}` : ''}`)
      return console.log(`\n${m.body}`)
    }

    case 'peer': {
      const cfg = loadConfig()
      const [sub, machine, transport, a, b] = args.filter(x => !x.startsWith('--'))
      if (sub === 'ls' || !sub) {
        const rows = [['MACHINE', 'TRANSPORT', 'TARGET', 'INTO CODEX/OMP']]
        for (const [k, v] of Object.entries(cfg.peers)) rows.push([k, v.transport, v.host || v.url, v.trust === 'deliver' ? 'deliver' : 'hold'])
        return console.log(table(rows))
      }
      if (sub === 'rm') { delete cfg.peers[machine]; saveConfig(cfg); return console.log(`removed ${machine}`) }
      const trust = flag(args, '--trust') ? { trust: 'deliver' } : {}
      if (sub === 'add' && transport === 'ssh' && a) {
        const c = flag(args, '--cmd')
        cfg.peers[machine] = { transport: 'ssh', host: a, ...(typeof c === 'string' && { cmd: c }), ...trust }
      } else if (sub === 'add' && transport === 'http' && a && b) {
        cfg.peers[machine] = { transport: 'http', url: a, key: b, ...trust }
      } else throw new Error('usage: xmsg peer add <machine> ssh <host> [--cmd=…] | http <url> <key>')
      saveConfig(cfg)
      return console.log(`peer ${machine} → ${transport} ${a} (restart the daemon: xmsg stop)`)
    }

    case 'approve': case 'deny': {
      if (!args[0]) throw new Error(`usage: xmsg ${cmd} <id>`)
      const m = (await daemonCall({ op: cmd, id: args[0] })).message
      return console.log(`${m.id.slice(0, 8)}  ${m.from_addr} → ${m.to_addr}  ${m.status}${m.detail ? `  (${m.detail})` : ''}`)
    }

    case 'key': return console.log(randomBytes(24).toString('base64url'))

    case 'accept': {
      const [machine, key] = args
      if (!machine || !key) throw new Error('usage: xmsg accept <machine> <key>')
      const cfg = loadConfig()
      cfg.acceptFrom = [...cfg.acceptFrom.filter(x => x.machine !== machine), { machine, key }]
      saveConfig(cfg)
      return console.log(`accepting http deliveries from ${machine} (restart the daemon: xmsg stop)`)
    }

    case 'config': {
      const cfg = loadConfig()
      const [key, value] = args
      if (!key) return console.log(JSON.stringify({ ...cfg, acceptFrom: cfg.acceptFrom.map(a => ({ machine: a.machine, key: '…' })) }, null, 2))
      if (value === undefined) return console.log(cfg[key] ?? '')
      cfg[key] = key === 'retryTtlSec' ? Number(value) : value
      saveConfig(cfg)
      return console.log(`${key} = ${value} (restart the daemon: xmsg stop)`)
    }

    case 'daemon': {
      const { Daemon } = await import('./daemon.js')
      const d = new Daemon()
      await d.start()
      const bye = () => { d.stop(); process.exit(0) }
      process.on('SIGTERM', bye)
      process.on('SIGINT', bye)
      return new Promise(() => {})
    }
    case 'start': { const r = await daemonCall({ op: 'ping' }); return console.log(`xmsgd running · machine ${r.machine} · pid ${r.pid}`) }
    case 'status': {
      try { const r = await daemonCall({ op: 'ping' }, { autostart: false }); console.log(`xmsgd running · machine ${r.machine} · pid ${r.pid}`) } catch { console.log('xmsgd not running') }
      return
    }
    case 'stop': {
      const { installed } = await import('./service.js')
      try {
        const r = await daemonCall({ op: 'ping' }, { autostart: false })
        process.kill(r.pid, 'SIGTERM')
        console.log(installed() ? `restarting xmsgd (pid ${r.pid}); the service brings it back` : `stopped xmsgd (pid ${r.pid})`)
      } catch { console.log('xmsgd not running') }
      return
    }
    case 'service': {
      const svc = await import('./service.js')
      if (args[0] === 'install') {
        try { const r = await daemonCall({ op: 'ping' }, { autostart: false }); process.kill(r.pid, 'SIGTERM'); await sleep(300) } catch {}
        return console.log(svc.install())
      }
      if (args[0] === 'uninstall') return console.log(svc.uninstall())
      throw new Error('usage: xmsg service install|uninstall')
    }

    // Used by the ssh transport on the receiving machine: one JSON object on
    // stdin, one JSON line on stdout.
    case 'remote': {
      const op = args[0]
      if (!['deliver', 'status', 'ls'].includes(op)) throw new Error('usage: xmsg remote deliver|status|ls')
      const payload = JSON.parse(readFileSync(0, 'utf8'))
      try {
        // ssh already authenticated the caller; payload.machine is its own name.
        const { remoteRequest } = await import('./daemon.js')
        console.log(JSON.stringify(await daemonCall(remoteRequest(op, payload, payload.machine))))
      } catch (e) { console.log(JSON.stringify({ error: e.message })) }
      return
    }

    case 'mcp': { const { runMcp } = await import('./mcp.js'); return runMcp(daemonCall, callerEnv) }

    default: throw new Error(`unknown command ${cmd}\n\n${HELP}`)
  }
}

