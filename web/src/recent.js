// Per-browser convenience list of recently visited channels.
const KEY = 'wd-recent';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function recentChannels() {
  return read().filter((r) => /^[0-9a-z]{7}$/.test(r.id) && r.expiresAt > Date.now()).slice(0, 6);
}

export function rememberChannel(id, expiresAt) {
  try {
    const list = [{ id, expiresAt }, ...read().filter((r) => r.id !== id)].slice(0, 12);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
}

export function forgetChannel(id) {
  try {
    localStorage.setItem(KEY, JSON.stringify(read().filter((r) => r.id !== id)));
  } catch { /* storage unavailable */ }
}
