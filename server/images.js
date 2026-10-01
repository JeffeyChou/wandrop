/** Image types shown inline, recognised by their magic bytes rather than the client's claim. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Accept raw image bodies in this plugin's scope. */
export function acceptImageBodies(app, bodyLimit) {
  app.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit }, (req, body, done) => done(null, body));
}

/** Headers for serving a stored image inline without letting it act as a document. */
export function imageHeaders(reply, mime, size, name) {
  return reply
    .header('Content-Type', IMAGE_TYPES.includes(mime) ? mime : 'application/octet-stream')
    .header('Content-Length', String(size))
    .header('Content-Disposition', `inline; filename="${name}.${String(mime).split('/')[1]}"`)
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Cache-Control', 'private, max-age=3600');
}
