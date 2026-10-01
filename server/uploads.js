// Resumable chunked uploads (a small subset of the tus idea):
//   POST   /api/channels/:id/uploads          declare name + size, reserve quota  -> { upload }
//   PUT    /api/channels/:id/uploads/:uid      append one chunk at Upload-Offset   -> { offset } | { file }
//   GET    /api/channels/:id/uploads           my unfinished uploads in this channel
//   GET    /api/channels/:id/uploads/:uid      current offset, to resume after a pause or reload
//   DELETE /api/channels/:id/uploads/:uid      cancel
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { now, tx } from './db.js';
import config from './config.js';
import { randomId, OPAQUE_ID_RE } from './util/ids.js';
import { sanitizeFilename, isStr } from './util/validate.js';
import { q, getChannel, blobPath, partPath, unlinkPart, uploadLimits, serializeFile, serializeUpload } from './store.js';
import { loadChannel } from './channels.js';
import { parseFileOptions } from './files.js';
import { broadcast } from './ws.js';

export const CHUNK_CONTENT_TYPE = 'application/offset+octet-stream';

/** Upload ids with a chunk or finalisation in flight; a second concurrent request gets 409. */
const busy = new Set();

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const mb = (n) => {
  const v = n / (1024 * 1024);
  return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v < 10 ? v.toFixed(1) : Math.round(v)} MB`;
};

/** Check every limit for a new upload and record it, atomically. */
const reserve = tx((actor, channel, row) => {
  const limits = uploadLimits(actor);
  const admin = actor.role === 'admin';
  const usage = q.channelUsage.get({ channel: channel.id });
  if (limits.maxFileBytes !== null && row.size > limits.maxFileBytes) throw fail(413, `Files are limited to ${mb(limits.maxFileBytes)}`);
  if (limits.quotaBytes !== null && limits.usedBytes + row.size > limits.quotaBytes) {
    throw fail(413, `Not enough storage: ${mb(limits.usedBytes)} of ${mb(limits.quotaBytes)} used, this file needs ${mb(row.size)}. Delete some files first.`);
  }
  if (usage.n >= config.maxFilesPerChannel) throw fail(429, 'Channel file limit reached');
  if (!admin && usage.bytes + row.size > config.channelQuotaBytes) throw fail(413, 'Channel storage quota exceeded');
  if (q.globalUsage.get().bytes + row.size > config.globalQuotaBytes) throw fail(507, 'Server storage is full');
  const t = now();
  q.insertUpload.run(row.id, channel.id, actor.key, actor.name, row.name, row.size, row.lastModified,
    row.maxDownloads, row.fileTtlSec, t, t);
});

function loadUpload(request, reply, channel) {
  const id = String(request.params.uid ?? '');
  const u = OPAQUE_ID_RE.test(id) ? q.upload.get(id, channel.id) : null;
  if (!u || u.uploader_key !== request.actor.key) {
    reply.code(404).send({ error: 'Upload not found' });
    return null;
  }
  return u;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Turn a complete upload into a stored file. */
async function finalize(u) {
  if (!getChannel(u.channel_id)) throw fail(410, 'Channel expired during upload');
  const sha256 = await sha256File(partPath(u.id));
  const fileId = randomId(18);
  await fs.promises.rename(partPath(u.id), blobPath(fileId));
  const t = now();
  tx(() => {
    q.deleteUpload.run(u.id);
    q.insertFile.run(fileId, u.channel_id, u.uploader_key, u.uploader_name, u.name, u.size, sha256,
      u.max_downloads, t, u.file_ttl_sec ? t + u.file_ttl_sec * 1000 : null);
  })();
  const file = serializeFile(q.file.get(fileId, u.channel_id));
  broadcast(u.channel_id, 'file:new', { file });
  return file;
}

export default async function uploadRoutes(app) {
  // Chunk bodies are streamed straight to disk; the route meters them itself.
  app.addContentTypeParser(CHUNK_CONTENT_TYPE, (request, payload, done) => done(null, payload));

  app.post('/api/channels/:id/uploads', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const actor = request.actor;
    if (!actor.isUser) return reply.code(401).send({ error: 'Log in to upload files' });

    const body = request.body ?? {};
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0) return reply.code(400).send({ error: 'Invalid file size' });
    if (!isStr(body.name, 1, 1024)) return reply.code(400).send({ error: 'File name required' });
    const lastModified = Number.isSafeInteger(body.lastModified) ? body.lastModified : null;
    const opts = parseFileOptions(body, reply, channel);
    if (!opts) return;

    const id = randomId(18);
    try {
      reserve(actor, channel, {
        id, size, lastModified, name: sanitizeFilename(body.name),
        maxDownloads: opts.maxDownloads ?? config.defaultMaxDownloads,
        fileTtlSec: opts.expiresAt ? Math.round((opts.expiresAt - now()) / 1000) : null,
      });
      await fs.promises.writeFile(partPath(id), '', { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      q.deleteUpload.run(id);
      throw err;
    }
    const u = q.upload.get(id, channel.id);
    if (size === 0) return { upload: serializeUpload(u), file: await finalize(u) };
    return { upload: serializeUpload(u) };
  });

  app.get('/api/channels/:id/uploads', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    return { uploads: q.myUploads.all(channel.id, request.actor.key).map(serializeUpload) };
  });

  app.get('/api/channels/:id/uploads/:uid', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const u = loadUpload(request, reply, channel);
    if (!u) return;
    return { upload: serializeUpload(u) };
  });

  app.put('/api/channels/:id/uploads/:uid', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const u = loadUpload(request, reply, channel);
    if (!u) return;
    if (!(request.body?.pipe)) return reply.code(415).send({ error: `Expected ${CHUNK_CONTENT_TYPE}` });
    const offset = Number(request.headers['upload-offset']);
    if (offset !== u.received) return reply.code(409).send({ error: 'Offset mismatch', offset: u.received });
    if (busy.has(u.id)) return reply.code(409).send({ error: 'Upload already in progress', offset: u.received });

    busy.add(u.id);
    try {
      const max = Math.min(config.uploadChunkBytes, u.size - u.received);
      let n = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          n += chunk.length;
          cb(n > max ? fail(413, 'Chunk too large') : null, chunk);
        },
      });
      let streamErr = null;
      try {
        await pipeline(request.body, meter, fs.createWriteStream(partPath(u.id), { flags: 'a' }));
      } catch (err) {
        streamErr = err; // e.g. the client paused mid-chunk; whatever reached the disk is kept
      }
      // Bytes are appended in order, so the file length is always a valid resume point.
      let received = Math.min((await fs.promises.stat(partPath(u.id))).size, u.size);
      if (received > u.received + max) {
        await fs.promises.truncate(partPath(u.id), u.received + max);
        received = u.received + max;
      }
      q.setReceived.run(received, now(), u.id);
      if (streamErr) {
        if (streamErr.statusCode) return reply.code(streamErr.statusCode).send({ error: streamErr.message, offset: received });
        return reply.code(400).send({ error: 'Upload interrupted', offset: received });
      }
      if (received < u.size) return { offset: received };
      return { offset: received, file: await finalize({ ...u, received }) };
    } catch (err) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    } finally {
      busy.delete(u.id);
    }
  });

  app.delete('/api/channels/:id/uploads/:uid', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const u = loadUpload(request, reply, channel);
    if (!u) return;
    if (busy.has(u.id)) return reply.code(409).send({ error: 'Upload is busy; pause it first' });
    q.deleteUpload.run(u.id);
    unlinkPart(u.id);
    return { ok: true };
  });
}
