import { now, tx } from './db.js';
import config from './config.js';
import { randomCode, CHANNEL_ID_RE } from './util/ids.js';
import { clampInt } from './util/validate.js';
import {
  q, getChannel, unlinkBlob, unlinkPart, uploadLimits, serializeChannel, serializeMessage, channelReadSet, serializeFile,
} from './store.js';
import { broadcast, broadcastEach, closeRoom } from './ws.js';
import { recordVisit } from './audit.js';

/** Delete a channel with all its messages/files and notify connected clients. */
export function destroyChannel(id) {
  const fileIds = q.fileIds.all(id, id).map((r) => r.id);
  const uploadIds = q.uploadIds.all(id).map((r) => r.id);
  const imageIds = q.imageIds.all(id).map((r) => r.id);
  q.deleteChannel.run(id); // messages, files and uploads rows cascade
  fileIds.forEach(unlinkBlob);
  imageIds.forEach(unlinkBlob);
  uploadIds.forEach(unlinkPart);
  broadcast(id, 'channel:closed');
  closeRoom(id);
}

/** Route helper: load a live channel or reply 404. */
export function loadChannel(request, reply) {
  const id = String(request.params.id ?? '');
  const channel = CHANNEL_ID_RE.test(id) ? getChannel(id) : null;
  if (!channel) reply.code(404).send({ error: 'Channel not found or expired' });
  return channel;
}

const createChannel = tx((actor) => {
  for (let i = 0; i < 20; i++) {
    const id = randomCode(7);
    if (q.channelAny.get(id)) continue;
    const t = now();
    q.insertChannel.run(id, actor.key, actor.isUser ? 'user' : 'anon', config.msgTtlDefault, t + config.channelTtlDefault * 1000, t);
    return id;
  }
  throw new Error('could not allocate channel id');
});

export default async function channelRoutes(app) {
  app.post('/api/channels', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    return { id: createChannel(request.actor) };
  });

  app.get('/api/channels/:id', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    recordVisit(request, channel.id);
    const t = now();
    const readSet = channelReadSet(channel.id, request.actor);
    return {
      channel: serializeChannel(channel),
      messages: q.messages.all(channel.id).filter((m) => !m.expires_at || m.expires_at > t)
        .map((m) => serializeMessage(m, request.actor, readSet)),
      files: q.files.all(channel.id).map(serializeFile),
      limits: {
        maxMessageChars: config.maxMessageChars, maxDownloadsCap: config.maxDownloadsCap, maxReadsCap: config.maxReadsCap, maxImageBytes: config.maxImageBytes, upload: uploadLimits(request.actor),
      },
      serverTime: t,
    };
  });

  app.patch('/api/channels/:id', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    if (channel.owner_key !== request.actor.key) return reply.code(403).send({ error: 'Only the channel owner can change settings' });

    const maxTtl = channel.owner_kind === 'user' ? config.channelTtlMaxUser : config.channelTtlMaxAnon;
    const body = request.body ?? {};
    let msgTtl = channel.msg_ttl_sec;
    let expiresAt = channel.expires_at;
    let mode = channel.msg_mode;
    let maxReads = channel.msg_max_reads;

    if (body.expiresInSec !== undefined) {
      const s = clampInt(body.expiresInSec, 60, maxTtl);
      if (s === null) return reply.code(400).send({ error: `Channel lifetime must be between 1 minute and ${maxTtl / 3600} hours` });
      expiresAt = now() + s * 1000;
    }
    if (body.msgTtlSec !== undefined) {
      const s = body.msgTtlSec === 0 ? 0 : clampInt(body.msgTtlSec, 10, maxTtl);
      if (s === null) return reply.code(400).send({ error: 'Invalid message retention' });
      msgTtl = s;
    }
    if (body.msgMode !== undefined) {
      if (body.msgMode !== 'time' && body.msgMode !== 'reads') return reply.code(400).send({ error: 'msgMode must be time or reads' });
      mode = body.msgMode;
    }
    if (body.msgMaxReads !== undefined) {
      const n = clampInt(body.msgMaxReads, 1, config.maxReadsCap);
      if (n === null) return reply.code(400).send({ error: `Views per message must be between 1 and ${config.maxReadsCap}` });
      maxReads = n;
    }

    const retimed = msgTtl !== channel.msg_ttl_sec;
    // Switching to burn-after-reading turns every remaining message into a read-limited one.
    // Switching back leaves read-limited messages alone: only new messages are time based again.
    const toReads = mode === 'reads' && channel.msg_mode !== 'reads';
    tx(() => {
      q.updateChannel.run(msgTtl, expiresAt, mode, maxReads, channel.id);
      if (retimed) q.retimeMessages.run(msgTtl, msgTtl, channel.id);
      if (toReads) q.readLimitAll.run(maxReads, channel.id);
    })();

    const updated = serializeChannel(q.channelAny.get(channel.id));
    broadcast(channel.id, 'channel:update', { channel: updated });
    if (retimed || toReads) {
      const rows = q.messages.all(channel.id);
      broadcastEach(channel.id, 'messages:sync', (actor) => {
        const readSet = channelReadSet(channel.id, actor);
        return { messages: rows.map((m) => serializeMessage(m, actor, readSet)) };
      });
    }
    return { channel: updated };
  });

  app.delete('/api/channels/:id', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    if (channel.owner_key !== request.actor.key) return reply.code(403).send({ error: 'Only the channel owner can delete it' });
    destroyChannel(channel.id);
    return { ok: true };
  });
}

