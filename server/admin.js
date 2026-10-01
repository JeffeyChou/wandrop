#!/usr/bin/env node
// Admin CLI: `node server/admin.js invite [maxUses] [ttlHours]` | `invites` | `users`
import db from './db.js';
import { createInvite } from './auth.js';

const [cmd, a, b] = process.argv.slice(2);

switch (cmd) {
  case 'invite': {
    const maxUses = Math.max(Number.parseInt(a, 10) || 1, 1);
    const ttlHours = Number.parseInt(b ?? '168', 10);
    console.log(createInvite({ maxUses, ttlSec: Math.max(ttlHours, 0) * 3600 }));
    break;
  }
  case 'invites':
    console.table(db.prepare('SELECT code, max_uses, used_count, datetime(expires_at/1000, \'unixepoch\') AS expires FROM invites').all());
    break;
  case 'users':
    console.table(db.prepare('SELECT id, username, role, datetime(created_at/1000, \'unixepoch\') AS created FROM users').all());
    break;
  default:
    console.log('Usage: node server/admin.js invite [maxUses=1] [ttlHours=168, 0=never] | invites | users');
    process.exitCode = 1;
}
