import fs from 'node:fs';
import { now, tx } from './db.js';
import config from './config.js';
import { randomId, OPAQUE_ID_RE } from './util/ids.js';
import { clampInt } from './util/validate.js';
import { q, blobPath, unlinkBlob, uploadLimits, serializeMessage } from './store.js';
import { loadChannel } from './channels.js';
import { broadcast, broadcastEach } from './ws.js';
import { sniffImage, acceptImageBodies, imageHeaders } from './images.js';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/** Delete a message (and its image) and tell the channel. `burned` = it reached its read limit. */
export function removeMessage(m, burned = false) {
  q.deleteMessage.run(m.id);
  if (m.image_id) unlinkBlob(m.image_id);
  broadcast(m.channel_id, burned ? 'message:burned' : 'message:delete', { id: m.id });
}

/** Send the current state of a message to everyone, each seeing it sealed or not. */
function broadcastMessage(type, m) {
  broadcastEach(m.channel_id, type, (actor) => ({ message: serializeMessage(m, actor) }));
}

/** Validate a message payload; replies with an error and returns null when invalid. */
function parseBody(request, reply) {
  const { body, format = 'plain' } = request.body ?? {};
  let error = null;
  if (typeof body !== 'string' || !body.trim()) error = [400, 'Message is empty'];
  else if (body.length > config.maxMessageChars) error = [413, `Message exceeds ${config.maxMessageChars} characters`];
  else if (format !== 'plain' && format !== 'md') error = [400, 'format must be plain or md'];
  if (error) {
    reply.code(error[0]).send({ error: error[1] });
    return null;
  }
  return { body, format };
}

function loadMessage(request, reply, channel) {
  const id = String(request.params.mid ?? '');
  const m = OPAQUE_ID_RE.test(id) ? q.message.get(id, channel.id) : null;
  if (!m) reply.code(404).send({ error: 'Message not found' });
  return m;
}

/** Insert a message for the actor, applying the channel's time or read limit. */
function insertMessage(channel, a, body, format, image = null) {
  if (q.countMessages.get(channel.id).n >= config.maxMessagesPerChannel) throw fail(429, 'Channel message limit reached');
  const id = randomId(12);
  const t = now();
  const byReads = channel.msg_mode === 'reads';
  const expiresAt = !byReads && channel.msg_ttl_sec ? t + channel.msg_ttl_sec * 1000 : null;
  q.insertMessage.run(id, channel.id, a.key, a.name, a.isUser ? 1 : 0, body, format, t, expiresAt,
    byReads ? channel.msg_max_reads : null, image?.id ?? null, image?.mime ?? null, image?.size ?? 0);
  const m = q.message.get(id, channel.id);
  broadcastMessage('message:new', m);
  return { message: serializeMessage(m, a) };
}

const sendLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export default async function messageRoutes(app) {
  acceptImageBodies(app, config.maxImageBytes);

  app.post('/api/channels/:id/messages', { config: sendLimit }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const input = parseBody(request, reply);
    if (!input) return;
    return insertMessage(channel, request.actor, input.body, input.format);
  });

  app.post('/api/channels/:id/images', {
    bodyLimit: config.maxImageBytes, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const a = request.actor;
    if (!a.isUser) return reply.code(401).send({ error: 'Log in to send images' });
    const buf = request.body;
    const mime = sniffImage(buf);
    if (!mime) return reply.code(415).send({ error: 'Only PNG, JPEG, GIF and WebP images can be sent inline' });
    const limits = uploadLimits(a);
    if (limits.quotaBytes !== null && limits.usedBytes + buf.length > limits.quotaBytes) return reply.code(413).send({ error: 'Not enough storage left for this image' });
    if (a.role !== 'admin' && q.channelUsage.get({ channel: channel.id }).bytes + buf.length > config.channelQuotaBytes) {
      return reply.code(413).send({ error: 'Channel storage quota exceeded' });
    }
    if (q.globalUsage.get().bytes + buf.length > config.globalQuotaBytes) return reply.code(507).send({ error: 'Server storage is full' });
    const imageId = randomId(18);
    await fs.promises.writeFile(blobPath(imageId), buf, { mode: 0o600 });
    try {
      return insertMessage(channel, a, '', 'plain', { id: imageId, mime, size: buf.length });
    } catch (err) {
      unlinkBlob(imageId);
      throw err;
    }
  });

  // Inline image. Viewing does not count as a read: a sealed image is only served after it was opened.
  app.get('/api/channels/:id/messages/:mid/image', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    if (!m.image_id) return reply.code(404).send({ error: 'Not an image' });
    if (serializeMessage(m, request.actor).sealed) return reply.code(403).send({ error: 'Open the message first' });
    let fh;
    try {
      fh = await fs.promises.open(blobPath(m.image_id), 'r');
    } catch {
      return reply.code(404).send({ error: 'Image is gone' });
    }
    imageHeaders(reply, m.image_mime, m.image_size, `image-${m.id}`);
    return reply.send(fh.createReadStream());
  });

  app.patch('/api/channels/:id/messages/:mid', { config: sendLimit }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    if (m.author_key !== request.actor.key) return reply.code(403).send({ error: 'You can only edit your own messages' });
    if (m.image_id) return reply.code(400).send({ error: 'Images cannot be edited' });
    const input = parseBody(request, reply);
    if (!input) return;
    q.editMessage.run(input.body, input.format, now(), m.id);
    const updated = q.message.get(m.id, channel.id);
    broadcastMessage('message:edit', updated);
    return { message: serializeMessage(updated, request.actor) };
  });

  // The author switches a message between time-based and read-limited, or changes the limit.
  // In a channel set to burn after reading, every message stays read-limited.
  app.patch('/api/channels/:id/messages/:mid/limit', { config: sendLimit }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    if (m.author_key !== request.actor.key) return reply.code(403).send({ error: 'Only the sender can change this' });
    const { maxReads } = request.body ?? {};
    if (maxReads === null) {
      if (channel.msg_mode === 'reads') return reply.code(400).send({ error: 'This channel destroys every message after it was read' });
      q.setReadLimit.run(null, channel.msg_ttl_sec ? m.created_at + channel.msg_ttl_sec * 1000 : null, m.id);
    } else {
      const n = clampInt(maxReads, m.reads + 1, config.maxReadsCap);
      if (n === null) return reply.code(400).send({ error: `Views must be between ${m.reads + 1} and ${config.maxReadsCap}` });
      q.setReadLimit.run(n, null, m.id);
    }
    const updated = q.message.get(m.id, channel.id);
    broadcastMessage('message:edit', updated);
    return { message: serializeMessage(updated, request.actor) };
  });

  // Open a read-limited message. Counts one read per viewer; the last allowed read destroys it.
  app.post('/api/channels/:id/messages/:mid/read', { config: sendLimit }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    const a = request.actor;
    if (m.max_reads === null || m.author_key === a.key) return { message: serializeMessage(m, a), burned: false };

    const counted = tx(() => q.insertRead.run(m.id, a.key, now()).changes > 0 && q.countRead.run(m.id).changes > 0)();
    const updated = q.message.get(m.id, channel.id);
    const message = serializeMessage(updated, a);
    const burned = updated.reads >= updated.max_reads;
    if (burned) {
      // The reader gets the content once more in this response; the image is served from memory.
      if (updated.image_id) {
        try {
          message.image = { ...message.image, url: `data:${updated.image_mime};base64,${(await fs.promises.readFile(blobPath(updated.image_id))).toString('base64')}` };
        } catch { message.image = null; }
      }
      removeMessage(updated, true);
    } else if (counted) {
      broadcast(channel.id, 'message:reads', { id: m.id, reads: updated.reads, maxReads: updated.max_reads });
    }
    return { message, burned };
  });

  app.delete('/api/channels/:id/messages/:mid', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    if (m.author_key !== request.actor.key && channel.owner_key !== request.actor.key) {
      return reply.code(403).send({ error: 'Not allowed' });
    }
    removeMessage(m);
    return { ok: true };
  });
}
