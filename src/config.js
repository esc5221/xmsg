// ~/.xmsg holds everything xmsg owns: config, the message store, the daemon's
// control socket and the omp registrations. XMSG_HOME moves it (tests use this).
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'

export function xmsgHome(env = process.env) {
  return env.XMSG_HOME || join(homedir(), '.xmsg')
}

export function paths(env = process.env) {
  const home = xmsgHome(env)
  return {
    home,
    config: join(home, 'config.json'),
    db: join(home, 'messages.db'),
    control: join(home, 'xmsgd.sock'),
    pid: join(home, 'xmsgd.pid'),
    log: join(home, 'xmsgd.log'),
    ompDir: join(home, 'omp'),
    sockDir: join(home, 's'),
  }
}

export function ensureHome(env = process.env) {
  const p = paths(env)
  for (const d of [p.home, p.ompDir, p.sockDir]) mkdirSync(d, { recursive: true, mode: 0o700 })
  return p
}

export function defaultMachine() {
  return hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

const DEFAULTS = {
  machine: null,          // address prefix for this machine; null → hostname
  listen: null,           // "host:port" for the http transport; null → no listener
  peers: {},              // name → { transport: "ssh", host } | { transport: "http", url, key }
  acceptFrom: [],         // http keys accepted from peers: [{ machine, key }]
  claudeConfigDirs: [],   // extra Claude config dirs to scan (ccx slot homes are found on their own)
  retryTtlSec: 3600,      // undeliverable messages are retried this long, then expire
}

export function loadConfig(env = process.env) {
  const p = paths(env)
  let file = {}
  if (existsSync(p.config)) file = JSON.parse(readFileSync(p.config, 'utf8'))
  const cfg = { ...DEFAULTS, ...file }
  cfg.machine = cfg.machine || defaultMachine()
  return cfg
}

export function saveConfig(cfg, env = process.env) {
  const p = ensureHome(env)
  const { machine, ...rest } = cfg
  const out = { ...rest, ...(machine && machine !== defaultMachine() && { machine }) }
  const tmp = p.config + '.tmp'
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, p.config)
}
