const path = require("node:path");
const fs = require("node:fs");
const session = require("express-session");
const Database = require("better-sqlite3");

class SQLiteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    const directory = path.resolve(options.dir || "server/data");
    fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(path.join(directory, options.db || "sessions.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `);
    this.getStatement = this.db.prepare("SELECT sess, expires_at FROM sessions WHERE sid = ?");
    this.setStatement = this.db.prepare(`
      INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
    `);
    this.destroyStatement = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?");
  }

  get(sid, callback) {
    try {
      const record = this.getStatement.get(sid);
      if (!record) return callback(null, null);
      if (record.expires_at <= Date.now()) {
        this.destroyStatement.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(record.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.setStatement.run(sid, JSON.stringify(sessionData), this.expiry(sessionData));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      this.touchStatement.run(this.expiry(sessionData), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.db.prepare("DELETE FROM sessions").run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  close() {
    this.db.close();
  }

  expiry(sessionData) {
    const expires = sessionData.cookie?.expires;
    if (expires) return new Date(expires).getTime();
    const maxAge = Number(sessionData.cookie?.maxAge);
    return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 24 * 60 * 60 * 1000);
  }
}

module.exports = { SQLiteSessionStore };
