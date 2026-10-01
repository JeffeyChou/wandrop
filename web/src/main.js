import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/main.css';
import { api } from './api.js';
import { h, icon, toast, remaining } from './ui.js';
import { startAsciiBackground, scrambleIn } from './ascii-bg.js';
import { authForm, openInvitesModal } from './account.js';
import { topbar } from './layout.js';
import { mountChannel } from './channel.js';
import { recentChannels } from './recent.js';

const LOGO = [
  '██╗    ██╗ █████╗ ███╗   ██╗██████╗ ██████╗  ██████╗ ██████╗ ',
  '██║    ██║██╔══██╗████╗  ██║██╔══██╗██╔══██╗██╔═══██╗██╔══██╗',
  '██║ █╗ ██║███████║██╔██╗ ██║██║  ██║██████╔╝██║   ██║██████╔╝',
  '██║███╗██║██╔══██║██║╚██╗██║██║  ██║██╔══██╗██║   ██║██╔═══╝ ',
  '╚███╔███╔╝██║  ██║██║ ╚████║██████╔╝██║  ██║╚██████╔╝██║     ',
  ' ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ',
].join('\n');

async function createChannel(btn) {
  btn.disabled = true;
  try {
    const { id } = await api('POST', '/api/channels');
    location.href = `/c/${id}`;
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
  }
}

function joinBox() {
  const input = h('input', {
    class: 'code-input', maxlength: 7, placeholder: 'a1b2c3d', autocomplete: 'off', spellcheck: 'false',
    'aria-label': '7-character channel code', inputmode: 'text',
  });
  const go = h('button', { type: 'submit', class: 'btn', disabled: true }, 'Join', icon('arrow'));
  input.addEventListener('input', () => {
    // Accept pasted links too: keep only the code characters.
    const m = input.value.toLowerCase().match(/\/c\/([0-9a-z]{7})/);
    input.value = (m ? m[1] : input.value.toLowerCase().replace(/[^0-9a-z]/g, '')).slice(0, 7);
    go.disabled = input.value.length !== 7;
  });
  return h('form', {
    class: 'join',
    onSubmit: (e) => {
      e.preventDefault();
      if (input.value.length === 7) location.href = `/c/${input.value}`;
    },
  }, input, go);
}

function recentList() {
  const items = recentChannels();
  if (!items.length) return null;
  return h('div', { class: 'recent' },
    h('div', { class: 'eyebrow' }, 'Recent channels'),
    h('div', { class: 'recent-items' }, ...items.map((r) => h('a', { class: 'recent-item', href: `/c/${r.id}` },
      h('code', {}, r.id), h('span', { class: 'muted' }, `≈ ${remaining(r.expiresAt - Date.now())} left`)))));
}

function renderHome(app, me) {
  const logo = h('pre', { class: 'ascii-logo', 'aria-label': 'WanDrop' });
  const createBtn = h('button', { type: 'button', class: 'btn primary xl', onClick: () => createChannel(createBtn) }, icon('plus'), 'New channel');

  const authCard = me.isUser
    ? h('section', { class: 'card glass auth-card signed-in' },
      h('span', { class: 'muted' }, 'Signed in as ', h('strong', {}, me.name)),
      me.role === 'admin' ? h('button', { type: 'button', class: 'btn', onClick: openInvitesModal }, icon('key'), 'Invite codes') : null)
    : h('section', { class: 'card glass auth-card' },
      h('div', { class: 'eyebrow' }, icon('lock'), 'Sign in to upload files'),
      authForm(() => location.reload()));

  app.replaceChildren(
    topbar(me),
    h('main', { class: 'home' },
      logo,
      h('p', { class: 'tagline' }, 'ephemeral clipboard', h('span', { class: 'sep' }, '//'), 'temporary file drop'),
      h('section', { class: 'card glass stack' },
        createBtn,
        h('div', { class: 'divider' }, h('span', {}, 'or join with a code')),
        joinBox(),
        recentList()),
      authCard));
  scrambleIn(logo, LOGO, 1100);
}

async function boot() {
  startAsciiBackground(document.getElementById('ascii-bg'));
  const app = document.getElementById('app');
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch (e) {
    app.replaceChildren(h('main', { class: 'center' }, h('p', {}, `Cannot reach server: ${e.message}`)));
    return;
  }
  const m = location.pathname.match(/^\/c\/([0-9a-z]{7})\/?$/);
  if (m) mountChannel(app, me, m[1]);
  else renderHome(app, me);
}

boot();
