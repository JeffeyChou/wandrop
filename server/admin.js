#!/usr/bin/env node
// Admin CLI: `node server/admin.js invite [maxUses] [ttlHours]` | `invites` | `users` | `passwd <username>`
import db from './db.js';
import { createInvite, setPassword } from './auth.js';
import { randomId } from './util/ids.js';

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
  case 'passwd': {
    // Generates the password instead of taking it as an argument, so it never lands in shell history.
    const password = randomId(18);
    if (!a || !(await setPassword(a, password))) {
      console.error(`No such user: ${a ?? '(missing username)'}`);
      process.exitCode = 1;
      break;
    }
    console.log(`New password for ${a}: ${password}\nAll of their sessions were signed out.`);
    break;
  }
  default:
    console.log('Usage: node server/admin.js invite [maxUses=1] [ttlHours=168, 0=never] | invites | users | passwd <username>');
    process.exitCode = 1;
}
