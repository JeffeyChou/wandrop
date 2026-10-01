import { now } from './db.js';
import config from './config.js';
import { randomId, OPAQUE_ID_RE } from './util/ids.js';
import { q, serializeMessage } from './store.js';
import { loadChannel } from './channels.js';
import { broadcast } from './ws.js';

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

const sendLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export default async function messageRoutes(app) {
  app.post('/api/channels/:id/messages', { config: sendLimit }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const input = parseBody(request, reply);
    if (!input) return;
    if (q.countMessages.get(channel.id).n >= config.maxMessagesPerChannel) {
      return reply.code(429).send({ error: 'Channel message limit reached' });
    }
    const a = request.actor;
    const id = randomId(12);
    const t = now();
    const expiresAt = channel.msg_ttl_sec ? t + channel.msg_ttl_sec * 1000 : null;
    q.insertMessage.run(id, channel.id, a.key, a.name, a.isUser ? 1 : 0, input.body, input.format, t, expiresAt);
    const message = serializeMessage(q.message.get(id, channel.id));
    broadcast(channel.id, 'message:new', { message });
    return { message };
  });

  app.patch('/api/channels/:id/messages/:mid', { config: sendLimit }, async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    if (m.author_key !== request.actor.key) return reply.code(403).send({ error: 'You can only edit your own messages' });
    const input = parseBody(request, reply);
    if (!input) return;
    q.editMessage.run(input.body, input.format, now(), m.id);
    const message = serializeMessage(q.message.get(m.id, channel.id));
    broadcast(channel.id, 'message:edit', { message });
    return { message };
  });

  app.delete('/api/channels/:id/messages/:mid', async (request, reply) => {
    const channel = loadChannel(request, reply);
    if (!channel) return;
    const m = loadMessage(request, reply, channel);
    if (!m) return;
    if (m.author_key !== request.actor.key && channel.owner_key !== request.actor.key) {
      return reply.code(403).send({ error: 'Not allowed' });
    }
    q.deleteMessage.run(m.id);
    broadcast(channel.id, 'message:delete', { id: m.id });
    return { ok: true };
  });
}
