import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';

import config from './config.js';
import db from './db.js';
import securityPlugin from './security.js';
import identityPlugin from './identity.js';
import authRoutes, { ensureAdmin } from './auth.js';
import channelRoutes from './channels.js';
import messageRoutes from './messages.js';
import fileRoutes from './files.js';
import uploadRoutes from './uploads.js';
import wsRoutes from './ws.js';
import auditRoutes from './audit.js';
import { startSweeper } from './sweeper.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: config.trustProxy,
  bodyLimit: 1024 * 1024,
});

// Hooks must apply to every route, so install them on the root instance.
await securityPlugin(app);
await app.register(cookie, { secret: config.cookieSecret });
await identityPlugin(app);
await app.register(rateLimit, { global: false });
await app.register(websocket, { options: { maxPayload: 1024 } });

app.setErrorHandler((err, request, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) request.log.error(err);
  reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
});

app.get('/healthz', async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(channelRoutes);
await app.register(messageRoutes);
await app.register(fileRoutes);
await app.register(uploadRoutes);
await app.register(wsRoutes);
await app.register(auditRoutes);

// Frontend (built by Vite into dist/). /c/:id is a client-side route.
if (fs.existsSync(path.join(config.staticDir, 'index.html'))) {
  await app.register(fastifyStatic, { root: config.staticDir, wildcard: true, index: ['index.html'] });
  app.get('/c/:id', (request, reply) => reply.sendFile('index.html'));
} else {
  app.log.warn(`No frontend build found in ${config.staticDir}; run "npm run build".`);
}

await ensureAdmin(app.log);
startSweeper(app.log);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
