import config from './config.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // KaTeX emits inline style attributes for layout.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // CSP3 'self' also matches ws:/wss: on the same host, so no other socket hosts are allowed.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Same-origin check for state-changing requests and WebSocket upgrades.
 * Requests without an Origin header (curl, server-to-server) carry no ambient
 * browser cookies from a third-party site, so they are allowed.
 */
export function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export default async function securityPlugin(app) {
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !isAllowedOrigin(request)) {
      reply.code(403).send({ error: 'Cross-origin request rejected' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}
