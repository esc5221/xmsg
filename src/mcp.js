// `xmsg mcp`: a stdio MCP server, for agents that prefer a tool over a shell
// command. It forwards to xmsgd like the CLI does; the sender is whoever
// launched the server (same identity variables as the CLI).
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'xmsg_send',
    description: 'Send a message to another running agent session (Claude Code, Codex, omp), on this machine or another. Address: [machine/][kind:]name, as listed by xmsg_ls.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' } }, required: ['to', 'message'] },
  },
  { name: 'xmsg_ls', description: 'List agent sessions with their xmsg addresses: this machine, and with all=true every peer machine too.', inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } } },
  { name: 'xmsg_inbox', description: 'Messages addressed to this session that were stored rather than injected.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'xmsg_show',
    description: 'Delivery status and trail of one message, by id or id prefix.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

export function runMcp(daemonCall, callerEnv) {
  const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')
  const text = (id, s, isError = false) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: s }], ...(isError && { isError }) } })

  const call = async (name, a) => {
    if (name === 'xmsg_send') {
      const r = await daemonCall({ op: 'send', env: callerEnv(), to: a.to, body: a.message })
      return `${r.id.slice(0, 8)} ${r.from} → ${r.to}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`
    }
    if (name === 'xmsg_ls') {
      const r = await daemonCall({ op: 'ls' })
      const lines = r.sessions.map(s => `${s.address}  ${s.status || ''}  ${s.cwd || ''}`)
      if (a.all) for (const p of (await daemonCall({ op: 'ls-peers' })).peers) {
        if (p.error) lines.push(`${p.machine}: unreachable (${p.error})`)
        else lines.push(...p.sessions.map(s => `${s.address}  ${s.status || ''}`))
      }
      return lines.join('\n') || 'no sessions'
    }
    if (name === 'xmsg_inbox') {
      const r = await daemonCall({ op: 'inbox', env: callerEnv() })
      return r.messages.map(m => `from ${m.from_addr} (${m.id.slice(0, 8)}):\n${m.body}`).join('\n\n') || `no messages for ${r.address}`
    }
    if (name === 'xmsg_show') {
      const r = await daemonCall({ op: 'show', id: a.id })
      return `${r.message.status}${r.message.detail ? ` (${r.message.detail})` : ''}\n` + r.events.map(e => `${new Date(e.ts).toISOString()} ${e.status} ${e.detail || ''}`).join('\n')
    }
    throw new Error(`unknown tool ${name}`)
  }

  createInterface({ input: process.stdin }).on('line', async line => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.id === undefined) return // notifications
    if (m.method === 'initialize') {
      return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'xmsg', version: '0.1.0' } } })
    }
    if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } })
    if (m.method === 'tools/call') {
      try { return text(m.id, await call(m.params.name, m.params.arguments || {})) } catch (e) { return text(m.id, e.message, true) }
    }
    if (m.method === 'ping') return out({ jsonrpc: '2.0', id: m.id, result: {} })
    out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } })
  })
}
