// The daemon's control socket speaks one JSON request line → one JSON response
// line per connection.
import net from 'node:net'

export function request(socketPath, req, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: socketPath })
    let buf = ''
    const timer = setTimeout(() => { s.destroy(); reject(new Error('xmsgd did not answer')) }, timeoutMs)
    s.setEncoding('utf8')
    s.once('error', e => { clearTimeout(timer); reject(e) })
    s.once('connect', () => s.write(JSON.stringify(req) + '\n'))
    s.on('data', d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      clearTimeout(timer)
      s.end()
      const res = JSON.parse(buf.slice(0, i))
      res.error ? reject(new Error(res.error)) : resolve(res)
    })
  })
}

export function serve(socketPath, handle) {
  return net.createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('error', () => {})
    conn.on('data', async d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      const line = buf.slice(0, i)
      buf = ''
      let res
      try { res = await handle(JSON.parse(line)) } catch (e) { res = { error: e.message } }
      conn.end(JSON.stringify(res ?? {}) + '\n')
    })
  }).listen(socketPath)
}
