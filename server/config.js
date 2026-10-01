import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;

function int(key, fallback) {
  const v = Number.parseInt(env[key] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function bool(key, fallback = false) {
  const v = (env[key] ?? '').toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

/** Read KEY, or the contents of the file named by KEY_FILE (Docker / Kubernetes secrets). */
function secret(key) {
  if (env[`${key}_FILE`]) return fs.readFileSync(env[`${key}_FILE`], 'utf8').trim();
  return env[key] || '';
}

const MB = 1024 * 1024;
const dataDir = path.resolve(env.DATA_DIR || '/data');

const config = {
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 8080),
  dataDir,
  dbPath: path.join(dataDir, 'wandrop.db'),
  filesDir: path.join(dataDir, 'files'),
  tmpDir: path.join(dataDir, 'files', '.tmp'),
  staticDir: path.resolve(env.STATIC_DIR || new URL('../dist', import.meta.url).pathname),

  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', false),
  // Optional comma separated list of allowed origins, e.g. "https://drop.example.com".
  // When empty the request Host header is used for same-origin checks.
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  adminUsername: env.ADMIN_USERNAME || 'admin',
  adminPassword: secret('ADMIN_PASSWORD'),
  sessionTtlSec: int('SESSION_TTL_SEC', 30 * 24 * 3600),

  // Channel / message lifetimes (seconds)
  msgTtlDefault: int('MSG_TTL_DEFAULT', 300),
  channelTtlDefault: int('CHANNEL_TTL_DEFAULT', 3600),
  channelTtlMaxAnon: int('CHANNEL_TTL_MAX_ANON', 24 * 3600),
  channelTtlMaxUser: int('CHANNEL_TTL_MAX_USER', 7 * 24 * 3600),

  // Limits
  maxMessageChars: int('MAX_MESSAGE_CHARS', 100_000),
  maxMessagesPerChannel: int('MAX_MESSAGES_PER_CHANNEL', 1000),
  maxFileBytes: int('MAX_FILE_MB', 100) * MB,
  channelQuotaBytes: int('CHANNEL_QUOTA_MB', 1024) * MB,
  globalQuotaBytes: int('GLOBAL_QUOTA_MB', 20 * 1024) * MB,
  maxFilesPerChannel: int('MAX_FILES_PER_CHANNEL', 200),
  defaultMaxDownloads: int('DEFAULT_MAX_DOWNLOADS', 2),
  maxDownloadsCap: int('MAX_DOWNLOADS_CAP', 1000),

  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 5000),
};

fs.mkdirSync(config.filesDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });

// Cookie signing secret: env wins, otherwise generated once and persisted in the data volume.
function loadSecret() {
  const fromEnv = secret('COOKIE_SECRET');
  if (fromEnv.length >= 32) return fromEnv;
  const file = path.join(dataDir, '.cookie-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* first boot */ }
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
config.cookieSecret = loadSecret();

export default config;
