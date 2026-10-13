// Steam oyun listesi (yeniden üretilebilir veri): yerel SQLite dosyası, kalıcı olması gerekmez.
const Database = require('better-sqlite3');
const catalog = new Database(process.env.CATALOG_PATH || 'catalog.db');
catalog.pragma('journal_mode = WAL');
catalog.exec(`
CREATE TABLE IF NOT EXISTS apps (appid INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS apps_name ON apps(name COLLATE NOCASE);`);
module.exports = catalog;
