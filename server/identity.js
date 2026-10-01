import db, { now } from './db.js';
import config from './config.js';
import { randomId, sha256, actorTag } from './util/ids.js';
import { randomName, ANON_NAME_RE } from './util/names.js';

export const ANON_COOKIE = 'wd_anon';
export const SESSION_COOKIE = 'wd_sess';

const findSession = db.prepare(`
  SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires_at > ?`);

export const cookieOpts = (maxAgeSec) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  maxAge: maxAgeSec,
});

function readAnon(request, reply) {
  const raw = request.cookies[ANON_COOKIE];
  if (raw) {
    const res = request.unsignCookie(raw);
    if (res.valid) {
      const [id, name] = res.value.split('.');
      if (id && /^[A-Za-z0-9_-]{16,}$/.test(id) && ANON_NAME_RE.test(name)) return { id, name };
    }
  }
  const anon = { id: randomId(16), name: randomName() };
  reply.setCookie(ANON_COOKIE, `${anon.id}.${anon.name}`, { ...cookieOpts(30 * 24 * 3600), signed: true });
  return anon;
}

/** Resolve who is making the request: a logged-in user or an anonymous visitor. */
export function resolveActor(request, reply) {
  const token = request.cookies[SESSION_COOKIE];
  if (token && token.length <= 128) {
    const u = findSession.get(sha256(token), now());
    if (u) {
      const key = `u:${u.id}`;
      return { key, tag: actorTag(key), name: u.username, isUser: true, userId: u.id, role: u.role };
    }
  }
  const anon = readAnon(request, reply);
  const key = `a:${anon.id}`;
  return { key, tag: actorTag(key), name: anon.name, isUser: false, userId: null, role: null };
}

export default async function identityPlugin(app) {
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      request.actor = resolveActor(request, reply);
    }
  });
}
