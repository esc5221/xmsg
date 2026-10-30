// Minimal WebSocket client (RFC 6455) over a unix socket. Codex's app-server
// control socket speaks WebSocket, and Node's global WebSocket cannot dial a
// unix path, so this covers exactly what the codex adapter needs: text frames,
// client masking, fragmentation, ping/pong and close.
import net from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function encodeFrame(opcode, payload, mask = randomBytes(4)) {
  const len = payload.length
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10
  const buf = Buffer.alloc(head + 4 + len)
  buf[0] = 0x80 | opcode
  if (len < 126) buf[1] = 0x80 | len
  else if (len < 65536) { buf[1] = 0x80 | 126; buf.writeUInt16BE(len, 2) }
  else { buf[1] = 0x80 | 127; buf.writeBigUInt64BE(BigInt(len), 2) }
  mask.copy(buf, head)
  for (let i = 0; i < len; i++) buf[head + 4 + i] = payload[i] ^ mask[i & 3]
  return buf
}

// Parses as many complete frames as `buf` holds; returns them plus the unread rest.
export function decodeFrames(buf) {
  const frames = []
  let off = 0
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1]
    let len = b1 & 0x7f, p = off + 2
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    const masked = b1 & 0x80
    let mask
    if (masked) { if (buf.length - p < 4) break; mask = buf.subarray(p, p + 4); p += 4 }
    if (buf.length - p < len) break
    let payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
    frames.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload })
    off = p + len
  }
  return { frames, rest: buf.subarray(off) }
}

export class UnixWebSocket extends EventEmitter {
  static connect(path, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ path })
      const key = randomBytes(16).toString('base64')
      const expect = createHash('sha1').update(key + GUID).digest('base64')
      let head = Buffer.alloc(0)
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`websocket handshake timed out: ${path}`)) }, timeoutMs)
      const onData = d => {
        head = Buffer.concat([head, d])
        const end = head.indexOf('\r\n\r\n')
        if (end < 0) return
        sock.off('data', onData)
        clearTimeout(timer)
        const text = head.subarray(0, end).toString('latin1')
        if (!/^HTTP\/1\.1 101/.test(text) || !text.toLowerCase().includes(`sec-websocket-accept: ${expect.toLowerCase()}`)) {
          sock.destroy()
          return reject(new Error(`websocket upgrade refused: ${text.split('\r\n')[0]}`))
        }
        const ws = new UnixWebSocket(sock)
        ws._feed(head.subarray(end + 4))
        resolve(ws)
      }
      sock.on('data', onData)
      sock.once('error', e => { clearTimeout(timer); reject(e) })
      sock.once('connect', () => sock.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
    })
  }

  constructor(sock) {
    super()
    this.sock = sock
    this.buf = Buffer.alloc(0)
    this.parts = []
    sock.on('data', d => this._feed(d))
    sock.on('close', () => this.emit('close'))
    sock.on('error', e => this.emit('error', e))
  }

  _feed(d) {
    if (!d.length) return
    this.buf = Buffer.concat([this.buf, d])
    const { frames, rest } = decodeFrames(this.buf)
    this.buf = Buffer.from(rest)
    for (const f of frames) {
      if (f.opcode === 0x9) { this.sock.write(encodeFrame(0xa, f.payload)); continue }
      if (f.opcode === 0xa) continue
      if (f.opcode === 0x8) { this.close(); continue }
      this.parts.push(f.payload)
      if (f.fin) {
        const msg = Buffer.concat(this.parts).toString('utf8')
        this.parts = []
        this.emit('message', msg)
      }
    }
  }

  send(text) { this.sock.write(encodeFrame(0x1, Buffer.from(text, 'utf8'))) }

  close() {
    if (this.sock.destroyed) return
    try { this.sock.write(encodeFrame(0x8, Buffer.alloc(0))) } catch {}
    this.sock.end()
    setTimeout(() => this.sock.destroy(), 200).unref()
  }
}
