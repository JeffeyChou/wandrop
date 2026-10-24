// Control chars, bidi overrides/isolates, zero-width & BOM, plus characters that are
// special on common filesystems / shells. The original file name is only ever stored
// in the database and rendered as text; it never touches a path or a command.
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const UNSAFE_RE = /[\/\\:*?"<>|`$;&]/g;
const MAX_NAME_BYTES = 200;

export function sanitizeFilename(raw) {
  let name = String(raw ?? '').normalize('NFC').replace(STRIP_RE, '').replace(UNSAFE_RE, '_');
  name = name.replace(/\.{2,}/g, '.').replace(/^[\s.]+/, '').replace(/[\s.]+$/, '').replace(/\s+/g, ' ');
  if (!name) name = 'file';
  // Trim to a byte budget while keeping the extension when possible.
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    let base = ext ? name.slice(0, dot) : name;
    while (Buffer.byteLength(base + ext) > MAX_NAME_BYTES) base = [...base].slice(0, -1).join('');
    name = base + ext;
  }
  return name;
}

/**
 * RFC 6266 / 5987 Content-Disposition with an ASCII fallback. `rawUtf8` puts the UTF-8 bytes of the
 * name in the plain `filename` instead, for `curl -OJ`, which ignores `filename*` (browsers prefer
 * `filename*`). Safe because sanitizeFilename already strips quotes, backslashes and control chars.
 */
export function contentDisposition(name, rawUtf8 = false) {
  const ascii = rawUtf8
    ? Buffer.from(name.replace(/["\\]/g, '_')).toString('latin1')
    : name.replace(/[^A-Za-z0-9._ -]/g, '_') || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function isStr(v, min, max) {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

export function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
