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
  updateChannel: db.prepare('UPDATE channels SET msg_ttl_sec = ?, expires_at = ?, msg_mode = ?, msg_max_reads = ? WHERE id = ?'),
  deleteChannel: db.prepare('DELETE FROM channels WHERE id = ?'),
  expiredChannels: db.prepare('SELECT id FROM channels WHERE expires_at <= ?'),

  messages: db.prepare('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at'),
  message: db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?'),
  countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?'),
  insertMessage: db.prepare(`INSERT INTO messages (id, channel_id, author_key, author_name, is_user, body, format, created_at, expires_at,
    max_reads, image_id, image_mime, image_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  editMessage: db.prepare('UPDATE messages SET body = ?, format = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  // Read-limited messages ignore the channel's retention.
  retimeMessages: db.prepare(`UPDATE messages SET expires_at = CASE WHEN ? = 0 THEN NULL ELSE created_at + ? * 1000 END
    WHERE channel_id = ? AND max_reads IS NULL`),
  readLimitAll: db.prepare('UPDATE messages SET max_reads = ?, expires_at = NULL WHERE channel_id = ? AND max_reads IS NULL'),
  setReadLimit: db.prepare('UPDATE messages SET max_reads = ?, expires_at = ? WHERE id = ?'),
  insertRead: db.prepare('INSERT OR IGNORE INTO message_reads (message_id, reader_key, read_at) VALUES (?, ?, ?)'),
  countRead: db.prepare('UPDATE messages SET reads = reads + 1 WHERE id = ?'),
  hasRead: db.prepare('SELECT 1 FROM message_reads WHERE message_id = ? AND reader_key = ?'),
  readIds: db.prepare(`SELECT r.message_id AS id FROM message_reads r JOIN messages m ON m.id = r.message_id
    WHERE m.channel_id = ? AND r.reader_key = ?`),
  expiredMessages: db.prepare('SELECT id, channel_id, image_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?'),
  imageIds: db.prepare('SELECT image_id AS id FROM messages WHERE channel_id = ? AND image_id IS NOT NULL'),
  allImageIds: db.prepare('SELECT image_id AS id FROM messages WHERE image_id IS NOT NULL'),

  files: db.prepare('SELECT * FROM files WHERE channel_id = ? ORDER BY created_at'),
  file: db.prepare('SELECT * FROM files WHERE id = ? AND channel_id = ?'),
  fileById: db.prepare('SELECT * FROM files WHERE id = ?'),
  fileIds: db.prepare('SELECT id FROM files WHERE channel_id = ? UNION ALL SELECT preview_id FROM files WHERE channel_id = ? AND preview_id IS NOT NULL'),
  allFileIds: db.prepare('SELECT id FROM files UNION ALL SELECT preview_id FROM files WHERE preview_id IS NOT NULL'),
  setPreview: db.prepare('UPDATE files SET preview_id = ?, preview_mime = ?, preview_size = ? WHERE id = ?'),
  // Usage counts stored files and images plus the declared size of unfinished uploads.
  channelUsage: db.prepare(`SELECT
    (SELECT COUNT(*) FROM files WHERE channel_id = @channel) + (SELECT COUNT(*) FROM uploads WHERE channel_id = @channel) AS n,
    (SELECT COALESCE(SUM(size + preview_size), 0) FROM files WHERE channel_id = @channel) + (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE channel_id = @channel)
      + (SELECT COALESCE(SUM(image_size), 0) FROM messages WHERE channel_id = @channel) AS bytes`),
  userUsage: db.prepare(`SELECT
    (SELECT COALESCE(SUM(size + preview_size), 0) FROM files WHERE uploader_key = @uploader) + (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE uploader_key = @uploader)
      + (SELECT COALESCE(SUM(image_size), 0) FROM messages WHERE author_key = @uploader) AS bytes`),
  globalUsage: db.prepare(`SELECT
    (SELECT COALESCE(SUM(size + preview_size), 0) FROM files) + (SELECT COALESCE(SUM(size), 0) FROM uploads)
      + (SELECT COALESCE(SUM(image_size), 0) FROM messages) AS bytes`),
  insertFile: db.prepare(`INSERT INTO files (id, channel_id, uploader_key, uploader_name, name, size, sha256, max_downloads, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  setLinkToken: db.prepare('UPDATE files SET link_token = ? WHERE id = ? AND link_token IS NULL'),
  updateFile: db.prepare('UPDATE files SET max_downloads = ?, expires_at = ? WHERE id = ?'),
  countDownload: db.prepare(`UPDATE files SET downloads = downloads + 1
    WHERE id = ? AND (max_downloads = 0 OR downloads < max_downloads) AND (expires_at IS NULL OR expires_at > ?)`),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),

  insertUpload: db.prepare(`INSERT INTO uploads (id, channel_id, uploader_key, uploader_name, name, size, last_modified,
    max_downloads, file_ttl_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upload: db.prepare('SELECT * FROM uploads WHERE id = ? AND channel_id = ?'),
  myUploads: db.prepare('SELECT * FROM uploads WHERE channel_id = ? AND uploader_key = ? ORDER BY created_at'),
  uploadIds: db.prepare('SELECT id FROM uploads WHERE channel_id = ?'),
  allUploadIds: db.prepare('SELECT id FROM uploads'),
  setReceived: db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?'),
  deleteUpload: db.prepare('DELETE FROM uploads WHERE id = ?'),
  staleUploads: db.prepare('SELECT id FROM uploads WHERE updated_at <= ?'),
  // Files that used up their download limit stay listed (and keep their blob) until they expire,
  // so the uploader can still raise the limit.
  expiredFiles: db.prepare('SELECT id, channel_id, preview_id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?'),
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

/** Path of an unfinished upload's partial data. */
export function partPath(uploadId) {
  if (!OPAQUE_ID_RE.test(uploadId)) throw new Error('invalid upload id');
  return path.join(config.tmpDir, uploadId);
}

export function unlinkPart(uploadId) {
  fs.rm(partPath(uploadId), { force: true }, () => {});
}

/** Upload limits for an actor. null means unlimited. */
export function uploadLimits(actor) {
  const admin = actor.role === 'admin';
  return {
    maxFileBytes: admin ? null : config.maxFileBytes,
    quotaBytes: admin ? null : config.userQuotaBytes,
    usedBytes: actor.isUser ? q.userUsage.get({ uploader: actor.key }).bytes : 0,
    chunkBytes: config.uploadChunkBytes,
  };
}

export const serializeUpload = (u) => ({
  id: u.id, name: u.name, size: u.size, offset: u.received, lastModified: u.last_modified, createdAt: u.created_at,
});

export const serializeChannel = (c) => ({
  id: c.id,
  ownerKind: c.owner_kind,
  ownerTag: actorTag(c.owner_key),
  msgTtlSec: c.msg_ttl_sec,
  expiresAt: c.expires_at,
  createdAt: c.created_at,
  maxTtlSec: c.owner_kind === 'user' ? config.channelTtlMaxUser : config.channelTtlMaxAnon,
  msgMode: c.msg_mode,
  msgMaxReads: c.msg_max_reads,
});

/**
 * A message as `viewer` may see it. The body of a read-limited message is withheld ("sealed")
 * until the viewer opens it, which counts as a read. `readSet` saves a query per message in lists.
 */
export function serializeMessage(m, viewer, readSet = null) {
  const sealed = m.max_reads !== null && m.author_key !== viewer.key
    && !(readSet ? readSet.has(m.id) : q.hasRead.get(m.id, viewer.key));
  const image = m.image_id && !sealed ? { url: `/api/channels/${m.channel_id}/messages/${m.id}/image`, mime: m.image_mime, size: m.image_size } : null;
  return { ...messageFields(m), body: sealed ? null : m.body, sealed, isImage: !!m.image_id, image };
}

export const channelReadSet = (channelId, viewer) => new Set(q.readIds.all(channelId, viewer.key).map((r) => r.id));

const messageFields = (m) => ({
  id: m.id,
  format: m.format,
  authorName: m.author_name,
  authorTag: actorTag(m.author_key),
  isUser: !!m.is_user,
  createdAt: m.created_at,
  editedAt: m.edited_at,
  expiresAt: m.expires_at,
  maxReads: m.max_reads,
  reads: m.reads,
});

export const serializeFile = (f) => ({
  id: f.id,
  name: f.name,
  size: f.size,
  sha256: f.sha256,
  uploaderName: f.uploader_name,
  uploaderTag: actorTag(f.uploader_key),
  preview: f.preview_id ? { url: `/api/channels/${f.channel_id}/files/${f.id}/preview`, mime: f.preview_mime, size: f.preview_size } : null,
  maxDownloads: f.max_downloads,
  downloads: f.downloads,
  createdAt: f.created_at,
  expiresAt: f.expires_at,
});
