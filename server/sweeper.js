import fs from 'node:fs';
import db, { now } from './db.js';
import config from './config.js';
import { q, unlinkPart } from './store.js';
import { removeMessage } from './messages.js';
import { destroyChannel } from './channels.js';
import { destroyFile } from './files.js';

const purgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const purgeInvites = db.prepare('DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at <= ?');

export function sweep() {
  const t = now();
  for (const { id } of q.expiredChannels.all(t)) destroyChannel(id);
  for (const m of q.expiredMessages.all(t)) removeMessage(m);
  for (const f of q.expiredFiles.all(t)) destroyFile(f);
  for (const { id } of q.staleUploads.all(t - config.uploadStaleSec * 1000)) {
    q.deleteUpload.run(id);
    unlinkPart(id);
  }
  purgeSessions.run(t);
  purgeInvites.run(t);
}

/** Remove blobs and partial uploads that have no database row (e.g. after a crash). */
export function removeOrphans(log) {
  const known = new Set([...q.allFileIds.all(), ...q.allImageIds.all()].map((r) => r.id));
  let removed = 0;
  for (const entry of fs.readdirSync(config.filesDir, { withFileTypes: true })) {
    if (entry.isFile() && !known.has(entry.name)) {
      fs.rmSync(`${config.filesDir}/${entry.name}`, { force: true });
      removed++;
    }
  }
  const pending = new Set(q.allUploadIds.all().map((r) => r.id));
  for (const entry of fs.readdirSync(config.tmpDir)) {
    if (!pending.has(entry)) fs.rmSync(`${config.tmpDir}/${entry}`, { force: true });
  }
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
