import { api } from './api.js';
import { ResumableUpload } from './uploader.js';
import {
  h, icon, iconButton, toast, copyText, copyButton, modal, switchToggle, clock, remaining, bytes, duration, hueOf, confirmDialog,
} from './ui.js';
import { renderMarkdown, renderPlain } from './render.js';
import { topbar } from './layout.js';
import { openAuthModal } from './account.js';
import { rememberChannel, forgetChannel } from './recent.js';
import { openVisitsModal } from './admin.js';

const MSG_TTL_OPTIONS = [60, 300, 900, 1800, 3600, 6 * 3600, 24 * 3600, 3 * 86400, 7 * 86400];
const CHANNEL_TTL_OPTIONS = [600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400];
const FILE_TTL_OPTIONS = [600, 1800, 3600, 3 * 3600, 6 * 3600, 86400, 3 * 86400];

export async function mountChannel(app, me, channelId) {
  const S = {
    me,
    channel: null,
    limits: null,
    skew: 0,
    messages: new Map(),
    files: new Map(),
    view: new Map(), // message id -> 'plain' | 'md' (per-viewer bubble switch)
    editing: new Set(),
    uploads: new Map(), // upload id -> { up: ResumableUpload, el }
    closed: false,
  };
  const serverNow = () => Date.now() + S.skew;
  const isOwner = () => S.channel && S.channel.ownerTag === me.tag;

  // ---------- skeleton ----------
  const timeline = h('div', { class: 'timeline', 'aria-live': 'polite' });
  const emptyState = h('div', { class: 'empty' },
    h('pre', { class: 'ascii-empty', 'aria-hidden': 'true' }, '  .-.\n (o o)  nothing here yet\n | O |  paste, type, drop.\n  `-`'),
  );
  // In-progress uploads live outside the timeline so a re-render does not drop them.
  const uploadsBox = h('div', { class: 'uploads' });
  const scroller = h('div', { class: 'scroller' }, emptyState, timeline, uploadsBox);
  const channelTimer = h('span', { class: 'timer', title: 'Channel dissolves in' });
  const presence = h('div', { class: 'presence' });
  const settingsBtn = iconButton('gear', 'Channel settings', () => openSettings());
  settingsBtn.hidden = true;
  const visitsBtn = me.role === 'admin' ? iconButton('users', 'Visitor log (admin)', () => openVisitsModal(channelId)) : null;

  const codeChip = h('button', {
    type: 'button', class: 'channel-code', title: 'Copy channel link',
    onClick: async () => { if (await copyText(location.href)) toast('Channel link copied', 'ok'); },
  }, h('span', { class: 'hash' }, '#'), channelId, icon('link'));

  const composer = buildComposer();
  const dropZone = h('div', { class: 'dropzone', hidden: true }, h('div', { class: 'dropzone-inner glass' }, icon('upload'), h('span', {}, 'Drop to upload')));

  app.classList.add('in-channel');
  app.replaceChildren(
    topbar(me, codeChip, h('span', { class: 'timer-wrap' }, icon('clock'), channelTimer), presence, visitsBtn, settingsBtn),
    h('main', { class: 'channel' }, scroller, composer.el),
    dropZone,
  );

  // ---------- load ----------
  async function load() {
    const data = await api('GET', `/api/channels/${channelId}?tz=${encodeURIComponent(timeZone())}`);
    S.skew = data.serverTime - Date.now();
    S.channel = data.channel;
    S.limits = data.limits;
    S.messages = new Map(data.messages.map((m) => [m.id, m]));
    S.files = new Map(data.files.map((f) => [f.id, f]));
    rememberChannel(channelId, S.channel.expiresAt);
    settingsBtn.hidden = !isOwner();
    composer.refresh();
    renderAll();
    if (me.isUser) loadPendingUploads();
  }

  try {
    await load();
  } catch (e) {
    forgetChannel(channelId);
    showClosed(e.status === 404 ? 'This channel does not exist or has dissolved.' : e.message);
    return;
  }
  connect();
  setInterval(tick, 1000);
  tick();

  // ---------- rendering ----------
  function items() {
    return [
      ...[...S.messages.values()].map((m) => ({ kind: 'm', t: m.createdAt, v: m })),
      ...[...S.files.values()].map((f) => ({ kind: 'f', t: f.createdAt, v: f })),
    ].sort((a, b) => a.t - b.t);
  }

  function renderAll() {
    timeline.replaceChildren(...items().map((it) => (it.kind === 'm' ? messageEl(it.v) : fileEl(it.v))));
    emptyState.hidden = timeline.childElementCount + uploadsBox.childElementCount > 0;
    scrollToBottom(true);
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }
  function scrollToBottom(force = false) {
    if (force || nearBottom()) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function insertSorted(el, createdAt) {
    const stick = nearBottom();
    el.dataset.t = createdAt;
    const after = [...timeline.children].find((c) => Number(c.dataset.t) > createdAt);
    timeline.insertBefore(el, after || null);
    emptyState.hidden = true;
    if (stick) scrollToBottom(true);
  }

  function removeEl(id) {
    const el = timeline.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add('vanish');
    setTimeout(() => {
      el.remove();
      emptyState.hidden = timeline.childElementCount > 0;
    }, 450);
  }

  function replaceEl(id, el) {
    const old = timeline.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (old) {
      el.dataset.t = old.dataset.t;
      old.replaceWith(el);
    }
  }

  function avatar(name, tag) {
    return h('span', { class: 'avatar', style: { '--h': hueOf(tag) } }, name.slice(0, 1).toUpperCase());
  }

  function lifeChip(createdAt, expiresAt, label) {
    if (!expiresAt) return h('span', { class: 'life', title: 'Kept until the channel dissolves' }, icon('infinity'), label || 'with channel');
    return h('span', { class: 'life', title: 'Disappears in' }, icon('clock'),
      h('span', { dataset: { exp: expiresAt } }, remaining(expiresAt - serverNow())));
  }

  function lifeBar(createdAt, expiresAt) {
    if (!expiresAt) return null;
    return h('div', { class: 'lifebar' }, h('i', { dataset: { start: createdAt, exp: expiresAt } }));
  }

  // ----- message bubble -----
  function messageEl(m) {
    const mine = m.authorTag === me.tag;
    const mode = S.view.get(m.id) || m.format;
    const body = h('div', { class: 'msg-body' });
    const paint = (md) => body.replaceChildren(md ? renderMarkdown(m.body) : renderPlain(m.body));
    paint(mode === 'md');

    const tools = h('div', { class: 'msg-tools' },
      switchToggle('MD', mode === 'md', (on) => { S.view.set(m.id, on ? 'md' : 'plain'); paint(on); }, 'Render as Markdown'),
      copyButton(() => m.body, 'Copy text'),
      mine ? iconButton('pen', 'Edit', () => startEdit(m, el, body)) : null,
      mine || isOwner() ? iconButton('trash', 'Delete', () => del(`/api/channels/${channelId}/messages/${m.id}`, 'Delete message?', 'This message will be removed for everyone in the channel.'), 'danger') : null);

    const el = h('article', { class: `msg glass ${mine ? 'mine' : ''}`, dataset: { id: m.id, t: m.createdAt } },
      h('div', { class: 'msg-head' },
        avatar(m.authorName, m.authorTag),
        h('span', { class: 'author' }, m.authorName),
        m.isUser ? h('span', { class: 'badge', title: 'Signed-in member' }, 'member') : null,
        h('time', { datetime: new Date(m.createdAt).toISOString() }, clock(m.createdAt)),
        tools),
      body,
      h('div', { class: 'msg-foot' },
        m.editedAt ? h('span', { class: 'edited' }, icon('pen'), `edited at ${clock(m.editedAt)}`) : null,
        h('span', { class: 'grow' }),
        lifeChip(m.createdAt, m.expiresAt)),
      lifeBar(m.createdAt, m.expiresAt));
    return el;
  }

  function startEdit(m, el, body) {
    if (S.editing.has(m.id)) return;
    S.editing.add(m.id);
    const ta = h('textarea', { class: 'edit-area', rows: 3, maxlength: S.limits.maxMessageChars });
    ta.value = m.body;
    const stop = () => {
      S.editing.delete(m.id);
      const cur = S.messages.get(m.id);
      if (cur) replaceEl(m.id, messageEl(cur));
    };
    const save = async () => {
      const value = ta.value;
      if (!value.trim()) return toast('Message cannot be empty', 'error');
      try {
        const { message } = await api('PATCH', `/api/channels/${channelId}/messages/${m.id}`, {
          body: value, format: S.view.get(m.id) || m.format,
        });
        S.messages.set(message.id, message);
        stop();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); stop(); }
    });
    body.replaceChildren(ta, h('div', { class: 'edit-actions' },
      h('span', { class: 'muted small' }, 'Ctrl/⌘ + Enter to save · Esc to cancel'),
      h('button', { type: 'button', class: 'btn ghost sm', onClick: stop }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary sm', onClick: save }, icon('check'), 'Save')));
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    el.classList.add('editing');
  }

  // ----- file card -----
  function fileEl(f) {
    const mine = f.uploaderTag === me.tag;
    const ext = (f.name.includes('.') ? f.name.split('.').pop() : 'file').slice(0, 4).toUpperCase();
    const left = f.maxDownloads === 0 ? null : Math.max(f.maxDownloads - f.downloads, 0);
    const exhausted = left === 0;
    const dlBtn = exhausted
      ? h('button', { type: 'button', class: 'btn sm', disabled: true, title: 'The uploader can raise the limit in file settings' }, icon('lock'), 'Limit reached')
      : h('button', { type: 'button', class: 'btn primary sm', onClick: () => download(f, dlBtn) }, icon('download'), 'Download');

    return h('article', { class: `file glass ${mine ? 'mine' : ''} ${exhausted ? 'exhausted' : ''}`, dataset: { id: f.id, t: f.createdAt } },
      h('div', { class: 'file-ext', style: { '--h': hueOf(f.sha256) } }, ext),
      h('div', { class: 'file-main' },
        h('div', { class: 'file-name', title: f.name }, f.name),
        h('div', { class: 'file-meta' },
          h('span', {}, bytes(f.size)),
          h('span', { title: `SHA-256 ${f.sha256}` }, `sha ${f.sha256.slice(0, 8)}`),
          h('span', {}, `by ${f.uploaderName}`),
          h('span', {}, clock(f.createdAt))),
        h('div', { class: 'file-chips' },
          h('span', { class: `life ${left !== null && left <= 1 ? 'warn' : ''}`, title: 'Downloads remaining' }, icon(left === null ? 'infinity' : 'download'),
            left === null ? 'unlimited' : exhausted ? `download limit reached (${f.downloads}/${f.maxDownloads})` : `${left} / ${f.maxDownloads} left`),
          lifeChip(f.createdAt, f.expiresAt, 'until channel ends'))),
      h('div', { class: 'file-actions' },
        dlBtn,
        mine ? iconButton('gear', 'File settings', () => openFileSettings(f)) : null,
        mine || isOwner() ? iconButton('trash', 'Delete file', () => del(`/api/channels/${channelId}/files/${f.id}`, 'Delete file?', `"${f.name}" will be removed for everyone in the channel.`), 'danger') : null));
  }

  async function download(f, btn) {
    btn.disabled = true;
    try {
      const { url } = await api('POST', `/api/channels/${channelId}/files/${f.id}/ticket`);
      const a = h('a', { href: url, download: '' });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setTimeout(() => { btn.disabled = false; }, 800);
    }
  }

  async function del(url, title, message) {
    if (!(await confirmDialog(title, message))) return;
    try {
      await api('DELETE', url);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ----- uploads -----
  const pct = (up) => (up.size ? Math.floor((up.sent / up.size) * 100) : 100);

  function uploadEl(up) {
    const bar = h('i', { style: { width: `${pct(up)}%` } });
    const status = up.state === 'uploading' ? `${pct(up)}%`
      : !up.file ? `interrupted at ${pct(up)}% · pick the same file to resume`
        : up.error || `paused at ${pct(up)}%`;
    const picker = h('input', { type: 'file', hidden: true });
    picker.addEventListener('change', () => {
      const f = picker.files[0];
      if (!f) return;
      if (!up.matches(f)) return toast(`That is not ${up.record.name} (${bytes(up.size)})`, 'error');
      up.file = f;
      runUpload(up);
    });
    const actions = up.state === 'uploading'
      ? [iconButton('pause', 'Pause upload', () => up.pause())]
      : [up.file
        ? iconButton('play', 'Resume upload', () => runUpload(up))
        : h('button', { type: 'button', class: 'btn sm', onClick: () => picker.click() }, icon('play'), 'Resume…'), picker];
    return h('article', { class: `file glass uploading ${up.state}` },
      h('div', { class: 'file-ext' }, icon(up.state === 'uploading' ? 'upload' : 'pause')),
      h('div', { class: 'file-main' },
        h('div', { class: 'file-name', title: up.record.name }, up.record.name),
        h('div', { class: 'file-meta' }, h('span', {}, `${bytes(up.sent)} / ${bytes(up.size)}`), h('span', { class: 'pct' }, status)),
        h('div', { class: 'progress' }, bar)),
      h('div', { class: 'file-actions' }, ...actions,
        iconButton('x', 'Cancel upload', async () => {
          if (await confirmDialog('Cancel upload?', `The uploaded part of "${up.record.name}" will be discarded.`, 'Discard')) up.cancel();
        }, 'danger')));
  }

  function onUploadChange(up) {
    const entry = S.uploads.get(up.id);
    if (!entry) return;
    if (up.state === 'done' || (up.state === 'failed' && up.canceled)) {
      entry.el.remove();
      S.uploads.delete(up.id);
      if (up.result && !S.files.has(up.result.id)) {
        S.files.set(up.result.id, up.result);
        insertSorted(fileEl(up.result), up.result.createdAt);
      }
      refreshUsage();
    } else if (up.state === 'failed') {
      toast(`${up.record.name}: ${up.error}`, 'error');
      entry.el.remove();
      S.uploads.delete(up.id);
      up.cancel(); // release the reserved quota
    } else {
      const el = uploadEl(up);
      entry.el.replaceWith(el);
      entry.el = el;
    }
    emptyState.hidden = timeline.childElementCount + uploadsBox.childElementCount > 0;
  }

  function track(up) {
    const el = uploadEl(up);
    S.uploads.set(up.id, { up, el });
    uploadsBox.append(el);
    emptyState.hidden = true;
    scrollToBottom(true);
  }

  const runUpload = (up) => up.run(S.limits.upload.chunkBytes);

  async function loadPendingUploads() {
    try {
      const { uploads } = await api('GET', `/api/channels/${channelId}/uploads`);
      for (const r of uploads) if (!S.uploads.has(r.id)) track(new ResumableUpload(channelId, r, null, onUploadChange));
    } catch { /* not critical */ }
  }

  async function refreshUsage() {
    try {
      const m = await api('GET', '/api/me');
      if (m.upload) S.limits.upload = m.upload;
      composer.refresh();
    } catch { /* ignore */ }
  }

  async function uploadFiles(fileList) {
    if (!me.isUser) return openAuthModal('Log in to upload files. Guests can still download.');
    for (const file of fileList) {
      // Picking a file that matches an interrupted upload continues it instead of starting over.
      const pending = [...S.uploads.values()].find(({ up }) => !up.file && up.matches(file));
      if (pending) {
        pending.up.file = file;
        await runUpload(pending.up);
        continue;
      }
      let up;
      try {
        up = await ResumableUpload.create(channelId, file, onUploadChange);
      } catch (e) {
        toast(`${file.name}: ${e.message}`, 'error');
        continue;
      }
      track(up);
      refreshUsage(); // the declared size is reserved from the start
      if (up.state === 'done') onUploadChange(up);
      else await runUpload(up);
    }
  }

  // Uploads paused by a dropped connection continue by themselves once the browser is back online.
  window.addEventListener('online', () => {
    for (const { up } of S.uploads.values()) if (up.offline) runUpload(up);
  });

  function uploadHint(u) {
    if (u.quotaBytes === null) return 'No upload limits';
    return `Files up to ${bytes(u.maxFileBytes)} · ${bytes(u.usedBytes)} of ${bytes(u.quotaBytes)} used`;
  }

  // ---------- composer ----------
  function buildComposer() {
    const ta = h('textarea', {
      class: 'composer-input', rows: 1, placeholder: 'Paste or type…', 'aria-label': 'Message',
    });
    const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    const attach = iconButton('clip', 'Attach files', () => (me.isUser ? fileInput.click() : openAuthModal('Log in to upload files. Guests can still download.')));
    const sendBtn = h('button', { type: 'button', class: 'btn primary send', 'aria-label': 'Send' }, icon('send'), h('span', { class: 'send-label' }, 'Send'));
    const hint = h('div', { class: 'composer-hint' });

    async function send() {
      const body = ta.value;
      if (!body.trim()) return;
      sendBtn.disabled = true;
      try {
        const { message } = await api('POST', `/api/channels/${channelId}/messages`, { body, format: 'plain' });
        ta.value = '';
        autoGrow(ta);
        if (!S.messages.has(message.id)) {
          S.messages.set(message.id, message);
          insertSorted(messageEl(message), message.createdAt);
        }
        scrollToBottom(true);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        sendBtn.disabled = false;
        ta.focus();
      }
    }

    ta.addEventListener('input', () => autoGrow(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); uploadFiles(files); }
    });
    sendBtn.addEventListener('click', send);
    fileInput.addEventListener('change', () => { uploadFiles([...fileInput.files]); fileInput.value = ''; });

    const el = h('footer', { class: 'composer glass' },
      h('div', { class: 'composer-row' }, attach, ta, h('div', { class: 'composer-actions' }, sendBtn)),
      hint, fileInput);

    return {
      el,
      refresh() {
        const ttl = S.channel.msgTtlSec;
        attach.classList.toggle('locked', !me.isUser);
        hint.replaceChildren(
          h('span', {}, `Ctrl/⌘ + Enter to send · ${ttl ? `messages fade after ${duration(ttl)}` : 'messages stay until the channel dissolves'}`),
          h('span', {}, me.isUser ? `${uploadHint(S.limits.upload)} · drag, paste or 📎` : 'Guest: clipboard only · log in to upload'));
      },
    };
  }

  // ---------- settings ----------
  function select(options, current, fmt, extra = []) {
    const sel = h('select', {});
    for (const [v, label] of [...extra, ...options.map((v) => [v, fmt(v)])]) {
      const opt = h('option', { value: v }, label);
      if (String(v) === String(current)) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }

  function openSettings() {
    const c = S.channel;
    const msgOpts = MSG_TTL_OPTIONS.filter((s) => s <= c.maxTtlSec);
    if (c.msgTtlSec && !msgOpts.includes(c.msgTtlSec)) msgOpts.push(c.msgTtlSec);
    const msgSel = select(msgOpts.sort((a, b) => a - b), c.msgTtlSec, duration, [[0, 'Until channel dissolves']]);
    const chanSel = select(CHANNEL_TTL_OPTIONS.filter((s) => s <= c.maxTtlSec), '', (s) => `${duration(s)} from now`, [['', `Keep current (${remaining(c.expiresAt - serverNow())} left)`]]);
    const err = h('p', { class: 'form-error' });

    const m = modal('Channel settings', h('form', {
      class: 'stack',
      onSubmit: async (e) => {
        e.preventDefault();
        const body = { msgTtlSec: Number(msgSel.value) };
        if (chanSel.value) body.expiresInSec = Number(chanSel.value);
        try {
          const { channel } = await api('PATCH', `/api/channels/${channelId}`, body);
          S.channel = channel;
          toast('Settings saved', 'ok');
          m.close();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Message retention'), msgSel,
      h('small', { class: 'muted' }, 'Applies to existing messages too, counted from when each was sent.')),
    h('label', { class: 'field' }, h('span', {}, 'Channel lifetime'), chanSel,
      h('small', { class: 'muted' }, `Max ${duration(c.maxTtlSec)} for ${c.ownerKind === 'user' ? 'member' : 'guest'}-owned channels. Files go with the channel.`)),
    err,
    h('button', { type: 'submit', class: 'btn primary block' }, 'Save'),
    h('div', { class: 'danger-zone' },
      h('div', {}, h('strong', {}, 'Destroy now'), h('p', { class: 'muted small' }, 'Deletes every message and file immediately.')),
      h('button', {
        type: 'button', class: 'btn danger',
        onClick: async () => {
          if (!(await confirmDialog('Destroy channel?', 'Every message and file in this channel will be deleted immediately.', 'Destroy'))) return;
          try {
            await api('DELETE', `/api/channels/${channelId}`);
            m.close();
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      }, icon('trash'), 'Destroy'))));
  }

  function openFileSettings(f) {
    const maxIn = h('input', { type: 'number', min: 0, max: S.limits.maxDownloadsCap });
    const exhausted = f.maxDownloads > 0 && f.downloads >= f.maxDownloads;
    // An exhausted file needs a higher limit to be downloadable again, so suggest one more download.
    maxIn.value = exhausted ? f.downloads + 1 : f.maxDownloads;
    const remainingSec = Math.floor((S.channel.expiresAt - serverNow()) / 1000);
    const ttlSel = select(FILE_TTL_OPTIONS.filter((s) => s <= remainingSec), '', (s) => `${duration(s)} from now`,
      [['', f.expiresAt ? `Keep current (${remaining(f.expiresAt - serverNow())} left)` : 'Keep: until channel dissolves'], ['channel', 'Until channel dissolves']]);
    const err = h('p', { class: 'form-error' });
    const m = modal('File settings', h('form', {
      class: 'stack',
      onSubmit: async (e) => {
        e.preventDefault();
        const body = { maxDownloads: Number(maxIn.value) };
        if (ttlSel.value) body.expiresInSec = ttlSel.value === 'channel' ? null : Number(ttlSel.value);
        try {
          await api('PATCH', `/api/channels/${channelId}/files/${f.id}`, body);
          m.close();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('p', { class: 'file-name' }, f.name),
    h('label', { class: 'field' }, h('span', {}, 'Download limit'), maxIn,
      h('small', { class: 'muted' }, exhausted
        ? `Limit reached after ${f.downloads} download${f.downloads === 1 ? '' : 's'}. Set a higher limit (or 0 = unlimited) to allow more.`
        : `0 = unlimited. Downloaded ${f.downloads}× so far. At the limit the file stays listed but can no longer be downloaded.`)),
    h('label', { class: 'field' }, h('span', {}, 'Self-destruct'), ttlSel),
    err,
    h('button', { type: 'submit', class: 'btn primary block' }, 'Save')));
  }

  // ---------- realtime ----------
  function connect() {
    let retry = 0;
    let ws;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?c=${channelId}`);
      ws.onopen = async () => {
        if (retry > 0) {
          try { await load(); } catch { /* handled by close */ }
        }
        retry = 0;
      };
      ws.onmessage = (e) => {
        try { onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
      };
      ws.onclose = (e) => {
        if (S.closed) return;
        if (e.code === 4404) return showClosed('This channel has dissolved.');
        retry++;
        setTimeout(open, Math.min(1000 * 2 ** retry, 15000));
      };
    };
    open();
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'message:new':
        if (S.messages.has(ev.message.id)) return;
        S.messages.set(ev.message.id, ev.message);
        insertSorted(messageEl(ev.message), ev.message.createdAt);
        break;
      case 'message:edit':
        S.messages.set(ev.message.id, ev.message);
        if (!S.editing.has(ev.message.id)) replaceEl(ev.message.id, messageEl(ev.message));
        break;
      case 'message:delete':
        S.messages.delete(ev.id);
        S.editing.delete(ev.id);
        removeEl(ev.id);
        break;
      case 'messages:retimed':
        for (const { id, expiresAt } of ev.messages) {
          const m = S.messages.get(id);
          if (!m) continue;
          m.expiresAt = expiresAt;
          if (!S.editing.has(id)) replaceEl(id, messageEl(m));
        }
        break;
      case 'file:new':
        if (S.files.has(ev.file.id)) return;
        S.files.set(ev.file.id, ev.file);
        insertSorted(fileEl(ev.file), ev.file.createdAt);
        break;
      case 'file:update':
        S.files.set(ev.file.id, ev.file);
        replaceEl(ev.file.id, fileEl(ev.file));
        break;
      case 'file:delete':
        S.files.delete(ev.id);
        removeEl(ev.id);
        if (me.isUser) refreshUsage();
        break;
      case 'channel:update':
        S.channel = ev.channel;
        rememberChannel(channelId, S.channel.expiresAt);
        composer.refresh();
        break;
      case 'channel:closed':
        showClosed('This channel has dissolved.');
        break;
      case 'presence':
        presence.replaceChildren(...ev.users.slice(0, 8).map((u) => h('span', {
          class: `avatar sm ${u.isUser ? 'member' : ''}`, style: { '--h': hueOf(u.tag) }, title: `${u.name}${u.tag === me.tag ? ' (you)' : ''}`,
        }, u.name.slice(0, 1).toUpperCase())),
        ...(ev.users.length > 8 ? [h('span', { class: 'avatar sm more' }, `+${ev.users.length - 8}`)] : []));
        break;
      default:
    }
  }

  // ---------- timers ----------
  function tick() {
    if (!S.channel || S.closed) return;
    const t = serverNow();
    const left = S.channel.expiresAt - t;
    channelTimer.textContent = remaining(left);
    channelTimer.classList.toggle('warn', left < 5 * 60 * 1000);
    for (const el of app.querySelectorAll('[data-exp]')) {
      const exp = Number(el.dataset.exp);
      if (el.dataset.start) {
        const start = Number(el.dataset.start);
        el.style.width = `${Math.max(0, Math.min(1, (exp - t) / (exp - start))) * 100}%`;
      } else {
        el.textContent = remaining(exp - t);
      }
    }
  }

  function showClosed(text) {
    if (S.closed) return;
    S.closed = true;
    forgetChannel(channelId);
    const overlay = h('div', { class: 'closed' },
      h('div', { class: 'card glass stack center' },
        h('pre', { class: 'ascii-empty', 'aria-hidden': 'true' }, '  . ˚ ·  ✦\n ·  ⋆  .  ˚\n   ✧ · .  ⋆'),
        h('h2', {}, 'Dissolved'),
        h('p', { class: 'muted' }, text),
        h('a', { class: 'btn primary', href: '/' }, icon('back'), 'Back home')));
    document.body.append(overlay);
  }

  // ---------- drag & drop ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropZone.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.hidden = true;
    if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]);
  });
}

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
}
