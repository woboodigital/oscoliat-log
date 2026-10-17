// TURSO_DATABASE_URL tanımlıysa kayıtlar Turso'da (ücretsiz, kalıcı) tutulur; yoksa yerel data.db kullanılır.
const REMOTE = !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
let db;
if (REMOTE) {
  const Libsql = require('libsql');
  db = new Libsql(process.env.REPLICA_PATH || 'replica.db',
    { syncUrl: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN, syncPeriod: 30 });
  db.sync();
} else {
  db = new (require('better-sqlite3'))(process.env.DB_PATH || 'data.db');
  db.pragma('journal_mode = WAL');
}
db.exec(`
CREATE TABLE IF NOT EXISTS games (
  appid INTEGER PRIMARY KEY, name TEXT NOT NULL, image TEXT,
  genres TEXT DEFAULT '[]', developer TEXT, release TEXT);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid INTEGER NOT NULL REFERENCES games(appid),
  score REAL NOT NULL CHECK(score >= 0 AND score <= 10),
  note TEXT DEFAULT '', played_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

for (const sql of [
  "ALTER TABLE plays ADD COLUMN status TEXT DEFAULT 'bitirdi'",
  "ALTER TABLE plays ADD COLUMN tags TEXT DEFAULT '[]'",
  "ALTER TABLE plays ADD COLUMN video_url TEXT DEFAULT ''",
  "ALTER TABLE games ADD COLUMN info TEXT DEFAULT ''"
]) { try { db.exec(sql); } catch (e) { /* kolon zaten var */ } }
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  appid INTEGER NOT NULL REFERENCES games(appid), PRIMARY KEY (list_id, appid));
`);
db.exec(`
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  play_id INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  score REAL NOT NULL CHECK(score >= 0 AND score <= 10),
  voter TEXT NOT NULL, ip TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(play_id, voter));
`);
if (!REMOTE) db.pragma('foreign_keys = ON');
db.catalog = require('./catalog');
module.exports = db;
