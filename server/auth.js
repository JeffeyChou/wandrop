import crypto from 'node:crypto';
import { promisify } from 'node:util';
import db, { now, tx } from './db.js';
import config from './config.js';
import { randomId, sha256 } from './util/ids.js';
import { USERNAME_RE, isStr } from './util/validate.js';
import { SESSION_COOKIE, cookieOpts } from './identity.js';
import { uploadLimits } from './store.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Used to keep login timing uniform when the user does not exist.
const DUMMY_HASH = await hashPassword(randomId(16));

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)'),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  updatePassword: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
  invite: db.prepare('SELECT * FROM invites WHERE code = ?'),
  useInvite: db.prepare(`UPDATE invites SET used_count = used_count + 1
    WHERE code = ? AND used_count < max_uses AND (expires_at IS NULL OR expires_at > ?)`),
  insertInvite: db.prepare('INSERT INTO invites (code, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
  listInvites: db.prepare('SELECT code, max_uses, used_count, expires_at, created_at FROM invites ORDER BY created_at DESC LIMIT 200'),
  deleteInvite: db.prepare('DELETE FROM invites WHERE code = ?'),
};

const PLACEHOLDER_PASSWORDS = new Set(['change-me-please', 'changeme', 'password', 'admin']);

/**
 * Bootstrap the first admin. ADMIN_* are only read while no admin exists; afterwards they
 * are ignored, so they can (and should) be removed from the environment.
 */
export async function ensureAdmin(log) {
  const { adminUsername: username, adminPassword } = config;
  if (q.countAdmins.get().n > 0) {
    if (adminPassword) log.warn('An admin already exists, so ADMIN_PASSWORD is ignored; remove it from your environment.');
    return;
  }
  if (!USERNAME_RE.test(username)) {
    log.error('ADMIN_USERNAME must match [A-Za-z0-9_-]{3,32}');
    return;
  }
  if (adminPassword && (adminPassword.length < 8 || PLACEHOLDER_PASSWORDS.has(adminPassword.toLowerCase()))) {
    log.error('ADMIN_PASSWORD must be at least 8 characters and not a placeholder; no admin was created.');
    return;
  }
  const password = adminPassword || randomId(18);
  if (q.userByName.get(username)) {
    log.error(`User "${username}" already exists but is not an admin; pick another ADMIN_USERNAME.`);
    return;
  }
  q.insertUser.run(username, await hashPassword(password), 'admin', now());
  if (adminPassword) log.info(`Admin account "${username}" created`);
  else log.warn(`Admin account "${username}" created with generated password: ${password}  (shown once; change it under the account menu after logging in)`);
}

/** Replace a user's password and sign out all of their sessions. */
export async function setPassword(username, password) {
  const user = q.userByName.get(username);
  if (!user) return false;
  const hash = await hashPassword(password);
  tx(() => {
    q.updatePassword.run(hash, user.id);
    q.deleteUserSessions.run(user.id);
  })();
  return true;
}

export function createInvite({ createdBy = null, maxUses = 1, ttlSec = 7 * 24 * 3600 } = {}) {
  const code = `${randomId(4)}-${randomId(4)}`.replace(/_/g, 'x');
  q.insertInvite.run(code, createdBy, maxUses, ttlSec ? now() + ttlSec * 1000 : null, now());
  return code;
}

function startSession(reply, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, now() + config.sessionTtlSec * 1000);
  reply.setCookie(SESSION_COOKIE, token, cookieOpts(config.sessionTtlSec));
}

export function requireAdmin(request, reply) {
  if (request.actor?.role !== 'admin') {
    reply.code(403).send({ error: 'Admin only' });
    return false;
  }
  return true;
}

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export default async function authRoutes(app) {
  app.get('/api/me', async (request) => {
    const a = request.actor;
    return { name: a.name, tag: a.tag, isUser: a.isUser, role: a.role, upload: a.isUser ? uploadLimits(a) : null };
  });

  app.post('/api/auth/register', { config: authLimit }, async (request, reply) => {
    const { username, password, invite } = request.body ?? {};
    if (!isStr(username, 3, 32) || !USERNAME_RE.test(username)) return reply.code(400).send({ error: 'Username: 3-32 chars of letters, digits, _ or -' });
    if (!isStr(password, 8, 128)) return reply.code(400).send({ error: 'Password must be 8-128 characters' });
    if (!isStr(invite, 4, 64)) return reply.code(400).send({ error: 'Invite code required' });

    const passHash = await hashPassword(password);
    try {
      const userId = tx(() => {
        if (q.useInvite.run(invite.trim(), now()).changes === 0) throw Object.assign(new Error('Invalid or used invite code'), { statusCode: 400 });
        if (q.userByName.get(username)) throw Object.assign(new Error('Username taken'), { statusCode: 409 });
        return q.insertUser.run(username, passHash, 'user', now()).lastInsertRowid;
      })();
      startSession(reply, Number(userId));
      return { ok: true };
    } catch (err) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/auth/login', { config: authLimit }, async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!isStr(username, 1, 64) || !isStr(password, 1, 128)) return reply.code(400).send({ error: 'Missing credentials' });
    const user = q.userByName.get(username);
    const ok = await verifyPassword(password, user?.pass_hash ?? DUMMY_HASH);
    if (!user || !ok) return reply.code(401).send({ error: 'Wrong username or password' });
    startSession(reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/password', { config: authLimit }, async (request, reply) => {
    if (!request.actor.isUser) return reply.code(401).send({ error: 'Log in first' });
    const { current, next } = request.body ?? {};
    if (!isStr(current, 1, 128)) return reply.code(400).send({ error: 'Current password required' });
    if (!isStr(next, 8, 128)) return reply.code(400).send({ error: 'New password must be 8-128 characters' });
    const user = q.userById.get(request.actor.userId);
    if (!(await verifyPassword(current, user.pass_hash))) return reply.code(403).send({ error: 'Current password is wrong' });
    // Signs out every session, including this one, then starts a fresh session here.
    await setPassword(user.username, next);
    startSession(reply, user.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) q.deleteSession.run(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/admin/invites', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return q.listInvites.all().map((i) => ({
      code: i.code, maxUses: i.max_uses, usedCount: i.used_count, expiresAt: i.expires_at, createdAt: i.created_at,
    }));
  });

  app.post('/api/admin/invites', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const maxUses = Math.min(Math.max(Number.parseInt(request.body?.maxUses, 10) || 1, 1), 1000);
    const ttlHours = Math.min(Math.max(Number.parseInt(request.body?.ttlHours, 10) || 0, 0), 24 * 365);
    return { code: createInvite({ createdBy: request.actor.userId, maxUses, ttlSec: ttlHours * 3600 }) };
  });

  app.delete('/api/admin/invites/:code', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    q.deleteInvite.run(String(request.params.code));
    return { ok: true };
  });
}
