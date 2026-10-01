import fs from 'node:fs';
import db, { now } from './db.js';
import config from './config.js';
import { q } from './store.js';
import { destroyChannel } from './channels.js';
import { destroyFile } from './files.js';
import { broadcast } from './ws.js';

const purgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const purgeInvites = db.prepare('DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at <= ?');

export function sweep() {
  const t = now();
  for (const { id } of q.expiredChannels.all(t)) destroyChannel(id);
  for (const m of q.expiredMessages.all(t)) {
    q.deleteMessage.run(m.id);
    broadcast(m.channel_id, 'message:delete', { id: m.id });
  }
  for (const f of q.expiredFiles.all(t)) destroyFile(f);
  purgeSessions.run(t);
  purgeInvites.run(t);
}

/** Remove blobs that have no database row (e.g. after a crash) and stale temp uploads. */
export function removeOrphans(log) {
  const known = new Set(q.allFileIds.all().map((r) => r.id));
  let removed = 0;
  for (const entry of fs.readdirSync(config.filesDir, { withFileTypes: true })) {
    if (entry.isFile() && !known.has(entry.name)) {
      fs.rmSync(`${config.filesDir}/${entry.name}`, { force: true });
      removed++;
    }
  }
  for (const entry of fs.readdirSync(config.tmpDir)) fs.rmSync(`${config.tmpDir}/${entry}`, { force: true });
  if (removed) log.info(`Removed ${removed} orphaned blob(s)`);
}

export function startSweeper(log) {
  removeOrphans(log);
  const timer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log.error(err, 'sweep failed');
    }
  }, config.sweepIntervalMs);
  timer.unref();
  return timer;
}
