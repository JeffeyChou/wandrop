import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import config from './config.js';
import { actorTag, OPAQUE_ID_RE } from './util/ids.js';

export const q = {
  channel: db.prepare('SELECT * FROM channels WHERE id = ? AND expires_at > ?'),
  channelAny: db.prepare('SELECT * FROM channels WHERE id = ?'),
  insertChannel: db.prepare(`INSERT INTO channels (id, owner_key, owner_kind, msg_ttl_sec, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  updateChannel: db.prepare('UPDATE channels SET msg_ttl_sec = ?, expires_at = ? WHERE id = ?'),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
  expiredChannels: db.prepare('SELECT id FROM channels WHERE expires_at <= ?'),

  messages: db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at'),
  message: db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?'),
  countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?'),
  insertMessage: db.prepare(`INSERT INTO messages (id, channel_id, author_key, author_name, is_user, body, format, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  editMessage: db.prepare('UPDATE messages SET body = ?, format = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  retimeMessages: db.prepare(`UPDATE messages SET expires_at = CASE WHEN ? = 0 THEN NULL ELSE created_at + ? * 1000 END
    WHERE channel_id = ?`),
  expiredMessages: db.prepare('SELECT id, channel_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?'),

  files: db.prepare('SELECT * FROM files WHERE channel_id = ? ORDER BY created_at'),
  file: db.prepare('SELECT * FROM files WHERE id = ? AND channel_id = ?'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  fileIds: db.prepare('SELECT id FROM files WHERE channel_id = ?'),
  allFileIds: db.prepare('SELECT id FROM files'),
  channelUsage: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE channel_id = ?'),
  globalUsage: db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM files'),
  insertFile: db.prepare(`INSERT INTO files (id, channel_id, uploader_key, uploader_name, name, size, sha256, max_downloads, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateFile: db.prepare('UPDATE files SET max_downloads = ?, expires_at = ? WHERE id = ?'),
  countDownload: db.prepare(`UPDATE files SET downloads = downloads + 1
    WHERE id = ? AND (max_downloads = 0 OR downloads < max_downloads) AND (expires_at IS NULL OR expires_at > ?)`),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  // Files that used up their download limit stay listed (and keep their blob) until they expire,
  // so the uploader can still raise the limit.
  expiredFiles: db.prepare('SELECT id, channel_id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?'),
};

export const getChannel = (id) => q.channel.get(id, Date.now());

/** Absolute path of a stored blob. Only server-generated ids ever reach this function. */
export function blobPath(fileId) {
  if (!OPAQUE_ID_RE.test(fileId)) throw new Error('invalid file id');
  return path.join(config.filesDir, fileId);
}

export function unlinkBlob(fileId) {
  fs.rm(blobPath(fileId), { force: true }, () => {});
}

export const serializeChannel = (c) => ({
  id: c.id,
  ownerKind: c.owner_kind,
  ownerTag: actorTag(c.owner_key),
  msgTtlSec: c.msg_ttl_sec,
  expiresAt: c.expires_at,
  createdAt: c.created_at,
  maxTtlSec: c.owner_kind === 'user' ? config.channelTtlMaxUser : config.channelTtlMaxAnon,
});

export const serializeMessage = (m) => ({
  id: m.id,
  body: m.body,
  format: m.format,
  authorName: m.author_name,
  authorTag: actorTag(m.author_key),
  isUser: !!m.is_user,
  createdAt: m.created_at,
  editedAt: m.edited_at,
  expiresAt: m.expires_at,
});

export const serializeFile = (f) => ({
  id: f.id,
  name: f.name,
  size: f.size,
  sha256: f.sha256,
  uploaderName: f.uploader_name,
  uploaderTag: actorTag(f.uploader_key),
  maxDownloads: f.max_downloads,
  downloads: f.downloads,
  createdAt: f.created_at,
  expiresAt: f.expires_at,
});
