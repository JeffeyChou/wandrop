import db, { now } from './db.js';
import config from './config.js';
import { actorTag, CHANNEL_ID_RE } from './util/ids.js';
import { requireAdmin } from './auth.js';
import { q } from './store.js';
import { onlineCount } from './ws.js';

const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

const upsertVisit = db.prepare(`INSERT INTO channel_visits
  (channel_id, actor_key, actor_name, is_user, ip, country, user_agent, timezone, language, first_seen, last_seen)
  VALUES (@channel, @key, @name, @isUser, @ip, @country, @ua, @tz, @lang, @t, @t)
  ON CONFLICT (channel_id, actor_key, ip, user_agent) DO UPDATE SET
    actor_name = excluded.actor_name, is_user = excluded.is_user, visits = visits + 1, last_seen = excluded.last_seen,
    country = COALESCE(excluded.country, country), timezone = COALESCE(excluded.timezone, timezone),
    language = COALESCE(excluded.language, language)`);

const listVisits = db.prepare('SELECT * FROM channel_visits WHERE channel_id = ? ORDER BY last_seen DESC');

// Expired-but-unswept messages are left out so the numbers match what visitors see.
const listChannels = db.prepare(`SELECT c.*,
  (SELECT username FROM users u WHERE 'u:' || u.id = c.owner_key) AS owner_user,
  (SELECT actor_name FROM channel_visits v WHERE v.channel_id = c.id AND v.actor_key = c.owner_key LIMIT 1) AS owner_visit,
  (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND (m.expires_at IS NULL OR m.expires_at > @t)) AS messages,
  (SELECT COALESCE(SUM(LENGTH(CAST(m.body AS BLOB))), 0) FROM messages m
    WHERE m.channel_id = c.id AND (m.expires_at IS NULL OR m.expires_at > @t)) AS message_bytes,
  (SELECT COUNT(*) FROM files f WHERE f.channel_id = c.id) AS files,
  (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.channel_id = c.id) AS file_bytes,
  (SELECT COUNT(*) FROM uploads p WHERE p.channel_id = c.id) AS uploads,
  (SELECT COALESCE(SUM(p.received), 0) FROM uploads p WHERE p.channel_id = c.id) AS upload_bytes,
  (SELECT COUNT(DISTINCT v.actor_key) FROM channel_visits v WHERE v.channel_id = c.id) AS visitors
  FROM channels c WHERE c.expires_at > @t ORDER BY c.created_at DESC`);

/** Client IP: Cloudflare's header when we sit behind a trusted proxy, else Fastify's view. */
function clientIp(request) {
  const cf = request.headers['cf-connecting-ip'];
  if (config.trustProxy && typeof cf === 'string' && cf.length <= 64) return cf;
  return request.ip || '';
}

function header(request, name, max) {
  const v = request.headers[name];
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

/** Record that the current actor opened a channel. Never throws: auditing must not break the page. */
export function recordVisit(request, channelId) {
  try {
    const a = request.actor;
    const tz = String(request.query?.tz ?? '');
    const country = header(request, 'cf-ipcountry', 8);
    upsertVisit.run({
      channel: channelId,
      key: a.key,
      name: a.name,
      isUser: a.isUser ? 1 : 0,
      ip: clientIp(request),
      country: config.trustProxy ? country : null,
      ua: header(request, 'user-agent', 512) ?? '',
      tz: TZ_RE.test(tz) ? tz : null,
      lang: header(request, 'accept-language', 64)?.split(',')[0].trim() || null,
      t: now(),
    });
  } catch (err) {
    request.log.warn(err, 'could not record channel visit');
  }
}

export default async function auditRoutes(app) {
  app.get('/api/admin/channels', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const t = now();
    return {
      serverTime: t,
      channels: listChannels.all({ t }).map((c) => ({
        id: c.id,
        ownerKind: c.owner_kind,
        ownerName: c.owner_user || c.owner_visit || null,
        msgTtlSec: c.msg_ttl_sec,
        createdAt: c.created_at,
        expiresAt: c.expires_at,
        messages: c.messages,
        messageBytes: c.message_bytes,
        files: c.files,
        fileBytes: c.file_bytes,
        uploads: c.uploads,
        uploadBytes: c.upload_bytes,
        visitors: c.visitors,
        online: onlineCount(c.id),
      })),
    };
  });

  app.get('/api/admin/channels/:id/visits', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const id = String(request.params.id ?? '');
    const channel = CHANNEL_ID_RE.test(id) ? q.channelAny.get(id) : null;
    if (!channel) return reply.code(404).send({ error: 'Channel not found' });
    return listVisits.all(id).map((v) => ({
      name: v.actor_name,
      tag: actorTag(v.actor_key),
      isUser: !!v.is_user,
      isOwner: v.actor_key === channel.owner_key,
      ip: v.ip,
      country: v.country,
      userAgent: v.user_agent,
      timezone: v.timezone,
      language: v.language,
      visits: v.visits,
      firstSeen: v.first_seen,
      lastSeen: v.last_seen,
    }));
  });
}
