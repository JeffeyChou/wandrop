import { CHANNEL_ID_RE } from './util/ids.js';
import { getChannel } from './store.js';
import { isAllowedOrigin } from './security.js';

/** channelId -> Set<{ socket, actor }> */
const rooms = new Map();

export function broadcast(channelId, type, data = {}) {
  const room = rooms.get(channelId);
  if (!room) return;
  const payload = JSON.stringify({ type, ...data });
  for (const { socket } of room) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

/** Like broadcast, but builds the payload per recipient (e.g. to withhold sealed message bodies). */
export function broadcastEach(channelId, type, build) {
  const room = rooms.get(channelId);
  if (!room) return;
  for (const { socket, actor } of room) {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type, ...build(actor) }));
  }
}

export function closeRoom(channelId) {
  const room = rooms.get(channelId);
  if (!room) return;
  for (const { socket } of room) socket.close(4404, 'channel closed');
  rooms.delete(channelId);
}

function presence(channelId) {
  const room = rooms.get(channelId);
  if (!room) return;
  const seen = new Map();
  for (const { actor } of room) seen.set(actor.tag, { name: actor.name, tag: actor.tag, isUser: actor.isUser });
  broadcast(channelId, 'presence', { users: [...seen.values()] });
}

export default async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const channelId = String(request.query?.c ?? '');
    if (!isAllowedOrigin(request) || !CHANNEL_ID_RE.test(channelId) || !getChannel(channelId)) {
      socket.close(4404, 'not found');
      return;
    }
    const member = { socket, actor: request.actor };
    if (!rooms.has(channelId)) rooms.set(channelId, new Set());
    rooms.get(channelId).add(member);
    presence(channelId);

    let alive = true;
    socket.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    // Clients never need to send anything; ignore input but cap its size via maxPayload.
    socket.on('message', () => {});
    socket.on('close', () => {
      clearInterval(ping);
      const room = rooms.get(channelId);
      if (!room) return;
      room.delete(member);
      if (room.size === 0) rooms.delete(channelId);
      else presence(channelId);
    });
  });
}
