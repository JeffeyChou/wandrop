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
`);

export default db;

export const now = () => Date.now();

/** Wrap a function in a SQLite transaction. */
export const tx = (fn) => db.transaction(fn);
