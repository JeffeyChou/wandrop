import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random string over [0-9a-z] using a CSPRNG (no modulo bias). */
export function randomCode(length = 7) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** URL-safe opaque id. */
export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Public, non-reversible tag for an actor key (lets clients recognise "mine" without leaking ids). */
export const actorTag = (key) => sha256(`tag:${key}`).slice(0, 16);

export const CHANNEL_ID_RE = /^[0-9a-z]{7}$/;
export const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
