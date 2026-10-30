// Addresses: [machine/][kind:]name
//   build               any local session named build
//   codex:build         only a codex thread
//   desktop/claude:review  a Claude session on the machine called desktop
// kind is one of KINDS; `cli` is a human or script calling xmsg directly.
export const KINDS = ['claude', 'codex', 'omp', 'ttym', 'cli']

export function parseAddress(s) {
  if (typeof s !== 'string' || !s.trim()) throw new Error('empty address')
  let rest = s.trim(), machine = null, kind = null
  const slash = rest.indexOf('/')
  if (slash > 0) { machine = rest.slice(0, slash); rest = rest.slice(slash + 1) }
  const colon = rest.indexOf(':')
  if (colon > 0 && KINDS.includes(rest.slice(0, colon))) { kind = rest.slice(0, colon); rest = rest.slice(colon + 1) }
  if (!rest) throw new Error(`address has no name: ${s}`)
  return { machine, kind, name: rest }
}

export function formatAddress({ machine, kind, name }) {
  return `${machine ? machine + '/' : ''}${kind ? kind + ':' : ''}${name}`
}

// Claude shows from-name as "@name"; keep it to characters it renders as-is.
export function displayName(addr) {
  const a = typeof addr === 'string' ? parseAddress(addr) : addr
  return [a.machine, a.kind, a.name].filter(Boolean).join('-').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}
