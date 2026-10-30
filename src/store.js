// Message store. Every message has one row and an append-only event trail, so
// `xmsg log` can show where a message went (queued → sent → held → delivered).
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

// Terminal states: nothing more will happen to the message.
export const FINAL = new Set(['delivered', 'denied', 'refused', 'dropped', 'expired', 'failed'])

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        via TEXT,
        origin TEXT NOT NULL DEFAULT 'local',
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS messages_status ON messages(status);
      CREATE TABLE IF NOT EXISTS events (
        msg_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS events_msg ON events(msg_id);
      -- Every name a local session has been seen with, so an address handed
      -- out before a rename still reaches the same session.
      CREATE TABLE IF NOT EXISTS names (
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        id TEXT NOT NULL,
        seen INTEGER NOT NULL,
        PRIMARY KEY (kind, name, id)
      );
    `)
    // to_id: the session the target resolved to when the message was sent.
    // reply_to: where answers should go (an id-based address for agents).
    const cols = this.db.prepare('PRAGMA table_info(messages)').all().map(c => c.name)
    for (const c of ['to_id', 'reply_to']) if (!cols.includes(c)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${c} TEXT`)
  }

  create({ id = randomUUID(), from, to, body, origin = 'local', toId = null, replyTo = null }) {
    const now = Date.now()
    this.db.prepare(`INSERT INTO messages (id, created, updated, from_addr, to_addr, body, status, origin, to_id, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, now, now, from, to, body, origin, toId, replyTo)
    this.event(id, 'queued')
    return this.get(id)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return row ? { ...row } : null
  }

  // Accepts a unique id prefix, like git.
  find(prefix) {
    const rows = this.db.prepare('SELECT * FROM messages WHERE id LIKE ? LIMIT 2').all(prefix + '%')
    return rows.length === 1 ? { ...rows[0] } : null
  }

  setStatus(id, status, { detail = null, via } = {}) {
    const cur = this.get(id)
    if (!cur) return null
    // A late receipt must not resurrect a finished message, except held → delivered/denied.
    if (FINAL.has(cur.status) && cur.status !== status) return cur
    this.db.prepare(`UPDATE messages SET status = ?, detail = ?, updated = ?${via ? ', via = ?' : ''} WHERE id = ?`)
      .run(...[status, detail, Date.now(), ...(via ? [via] : []), id])
    this.event(id, status, detail)
    return this.get(id)
  }

  bumpAttempt(id) { this.db.prepare('UPDATE messages SET attempts = attempts + 1 WHERE id = ?').run(id) }

  event(id, status, detail = null) {
    this.db.prepare('INSERT INTO events (msg_id, ts, status, detail) VALUES (?, ?, ?, ?)').run(id, Date.now(), status, detail)
  }

  events(id) { return this.db.prepare('SELECT ts, status, detail FROM events WHERE msg_id = ? ORDER BY rowid').all(id).map(r => ({ ...r })) }

  // Written to a busy Claude session: delivered once its transcript shows it.
  unconfirmed(sinceMs) { return this.db.prepare(`SELECT * FROM messages WHERE status = 'sent' AND via = 'claude' AND created > ? ORDER BY created`).all(sinceMs).map(r => ({ ...r })) }

  pending() { return this.db.prepare(`SELECT * FROM messages WHERE status = 'queued' ORDER BY created`).all().map(r => ({ ...r })) }

  recent(limit = 30) { return this.db.prepare('SELECT * FROM messages ORDER BY created DESC LIMIT ?').all(limit).map(r => ({ ...r })) }

  rememberNames(sessions) {
    const now = Date.now()
    const up = this.db.prepare(`INSERT INTO names (kind, name, id, seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind, name, id) DO UPDATE SET seen = excluded.seen`)
    for (const s of sessions) if (s.name && s.id) up.run(s.kind, s.name, s.id, now)
  }

  // Ids of sessions that have carried `name`, most recent first.
  formerIds(kind, name) {
    const rows = kind
      ? this.db.prepare('SELECT id FROM names WHERE kind = ? AND name = ? ORDER BY seen DESC').all(kind, name)
      : this.db.prepare('SELECT id FROM names WHERE name = ? ORDER BY seen DESC').all(name)
    return rows.map(r => r.id)
  }

  close() { this.db.close() }
}
