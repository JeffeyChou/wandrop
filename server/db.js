import Database from 'better-sqlite3';
import config from './config.js';

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL,
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('user','anon')),
  msg_ttl_sec INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_key  TEXT NOT NULL,
  author_name TEXT NOT NULL,
  is_user     INTEGER NOT NULL,
  body        TEXT NOT NULL,
  format      TEXT NOT NULL CHECK (format IN ('plain','md')),
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  expires_at  INTEGER
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uploader_key   TEXT NOT NULL,
  uploader_name  TEXT NOT NULL,
  name           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  max_downloads  INTEGER NOT NULL,
  downloads      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER
);
CREATE INDEX IF NOT EXISTS files_channel ON files(channel_id, created_at);
CREATE INDEX IF NOT EXISTS files_uploader ON files(uploader_key);

-- Unfinished resumable uploads. Their declared size counts against quotas from the start.
CREATE TABLE IF NOT EXISTS uploads (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uploader_key   TEXT NOT NULL,
  uploader_name  TEXT NOT NULL,
  name           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  received       INTEGER NOT NULL DEFAULT 0,
  last_modified  INTEGER,
  max_downloads  INTEGER NOT NULL,
  file_ttl_sec   INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_channel ON uploads(channel_id);
CREATE INDEX IF NOT EXISTS uploads_uploader ON uploads(uploader_key);

-- Who has opened a read-limited message. The author never counts as a reader.
CREATE TABLE IF NOT EXISTS message_reads (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reader_key  TEXT NOT NULL,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (message_id, reader_key)
);
`);

/** Add columns introduced after the first release to existing databases. */
function addColumn(table, column, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
// Burn after reading: a channel either expires messages by time or by number of readers.
addColumn('channels', 'msg_mode', "TEXT NOT NULL DEFAULT 'time' CHECK (msg_mode IN ('time','reads'))");
addColumn('channels', 'msg_max_reads', 'INTEGER NOT NULL DEFAULT 1');
// max_reads NULL = time based; otherwise the message is destroyed once `reads` reaches it.
addColumn('messages', 'max_reads', 'INTEGER');
addColumn('messages', 'reads', 'INTEGER NOT NULL DEFAULT 0');
// Image messages keep their blob under image_id in the files directory; it goes with the message.
addColumn('messages', 'image_id', 'TEXT');
addColumn('messages', 'image_mime', 'TEXT');
addColumn('messages', 'image_size', 'INTEGER NOT NULL DEFAULT 0');
// Compressed preview of an image file, uploaded by the sender's browser; the original stays untouched.
addColumn('files', 'preview_id', 'TEXT');
addColumn('files', 'preview_mime', 'TEXT');
addColumn('files', 'preview_size', 'INTEGER NOT NULL DEFAULT 0');

export default db;

export const now = () => Date.now();

/** Wrap a function in a SQLite transaction. */
export const tx = (fn) => db.transaction(fn);
