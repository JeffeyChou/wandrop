import fs from 'node:fs';
import { now } from './db.js';
import config from './config.js';
import { randomId, OPAQUE_ID_RE } from './util/ids.js';
import { contentDisposition, clampInt } from './util/validate.js';
import { q, getChannel, blobPath, unlinkBlob, serializeFile } from './store.js';
import { loadChannel } from './channels.js';
import { broadcast } from './ws.js';

/** One-shot download tickets so link previewers / prefetchers can't burn download counts. */
const tickets = new Map(); // token -> { fileId, exp }
const TICKET_TTL_MS = 60_000;

setInterval(() => {
  const t = now();
  for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k);
}, 30_000).unref();

export function destroyFile(file) {
  q.deleteFile.run(file.id);
  unlinkBlob(file.id);
  broadcast(file.channel_id, 'file:delete', { id: file.id });
}

function loadFile(request, reply, channel) {
  const id = String(request.params.fid ?? '');
  const f = OPAQUE_ID_RE.test(id) ? q.file.get(id, channel.id) : null;
  if (!f) reply.code(404).send({ error: 'File not found' });
  return f;
}

/** Parse uploader options. Returns null (after replying) when invalid. */
export function parseFileOptions(input, reply, channel, file = null) {
  const out = {};
  if (input.maxDownloads !== undefined && input.maxDownloads !== '') {
    const n = clampInt(input.maxDownloads, 0, config.maxDownloadsCap);
    if (n === null || (file && n !== 0 && n <= file.downloads)) {
      reply.code(400).send({ error: `Download limit must be 0 (unlimited) or 1-${config.maxDownloadsCap} and above downloads so far` });
      return null;
    }
    out.maxDownloads = n;
  }
  if (input.expiresInSec !== undefined && input.expiresInSec !== '') {
    if (input.expiresInSec === null || input.expiresInSec === 'channel') {
      out.expiresAt = null;
    } else {
      const s = clampInt(input.expiresInSec, 60, Math.max(60, Math.floor((channel.expires_at - now()) / 1000)));
      if (s === null) {
        reply.code(400).send({ error: 'File lifetime must be at least 1 minute and within the channel lifetime' });
        return null;
      }
      out.expiresAt = now() + s * 1000;
    }
  }
  return out;
}

export default async function fileRoutes(app) {
  app.patch('/api/channels/:id/files/:fid', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const f = loadFile(request, reply, channel);
    if (!f) return;
    if (f.uploader_key !== request.actor.key) return reply.code(403).send({ error: 'Only the uploader can change this file' });
    const opts = parseFileOptions(request.body ?? {}, reply, channel, f);
    if (!opts) return;
    q.updateFile.run(opts.maxDownloads ?? f.max_downloads, opts.expiresAt !== undefined ? opts.expiresAt : f.expires_at, f.id);
    const file = serializeFile(q.file.get(f.id, channel.id));
    broadcast(channel.id, 'file:update', { file });
    return { file };
  });

  app.delete('/api/channels/:id/files/:fid', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const f = loadFile(request, reply, channel);
    if (!f) return;
    if (f.uploader_key !== request.actor.key && channel.owner_key !== request.actor.key) {
      return reply.code(403).send({ error: 'Not allowed' });
    }
    destroyFile(f);
    return { ok: true };
  });

  // Step 1: obtain a short-lived single-use ticket (POST, same-origin only).
  app.post('/api/channels/:id/files/:fid/ticket', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const f = loadFile(request, reply, channel);
    if (!f) return;
    if (f.max_downloads > 0 && f.downloads >= f.max_downloads) return reply.code(410).send({ error: 'Download limit reached' });
    const token = randomId(24);
    tickets.set(token, { fileId: f.id, exp: now() + TICKET_TTL_MS });
    return { url: `/dl/${token}` };
  });

  // Step 2: redeem the ticket. Counts one download and streams the blob as an attachment.
  app.get('/dl/:token', async (request, reply) => {
    const token = String(request.params.token ?? '');
    const ticket = tickets.get(token);
    tickets.delete(token);
    const gone = () => reply.code(410).type('text/plain; charset=utf-8').send('This download link has expired or the file is gone.');
    if (!ticket || ticket.exp <= now()) return gone();

    const f = q.fileById.get(ticket.fileId);
    if (!f || !getChannel(f.channel_id)) return gone();

    let fh;
    try {
      fh = await fs.promises.open(blobPath(f.id), 'r');
    } catch {
      return gone();
    }
    if (q.countDownload.run(f.id, now()).changes === 0) {
      await fh.close();
      return gone();
    }

    broadcast(f.channel_id, 'file:update', { file: serializeFile(q.fileById.get(f.id)) });

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', contentDisposition(f.name))
      .header('Content-Length', String(f.size))
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'no-store');
    return reply.send(fh.createReadStream());
  });
}
