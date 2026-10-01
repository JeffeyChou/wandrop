import { api } from './api.js';
import { h, icon, modal, toast, copyButton, clock } from './ui.js';
import { openChannelsModal } from './admin.js';

/** Inline login / register form. Calls onDone() after a successful sign-in. */
export function authForm(onDone, initialTab = 'login') {
  let tab = initialTab;
  const err = h('p', { class: 'form-error', role: 'alert' });
  const user = h('input', { name: 'username', autocomplete: 'username', placeholder: 'username', required: true, maxlength: 32 });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', placeholder: 'password', required: true, maxlength: 128 });
  const invite = h('input', { name: 'invite', placeholder: 'invite code', autocomplete: 'off', maxlength: 64 });
  const inviteRow = h('label', { class: 'field' }, h('span', {}, 'Invite code'), invite);
  const submit = h('button', { type: 'submit', class: 'btn primary block' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });

  const sync = () => {
    tabs.replaceChildren(
      ...[['login', 'Log in'], ['register', 'Register']].map(([k, label]) => h('button', {
        type: 'button', role: 'tab', class: `tab ${tab === k ? 'active' : ''}`, 'aria-selected': String(tab === k),
        onClick: () => { tab = k; sync(); },
      }, label)),
    );
    inviteRow.hidden = tab !== 'register';
    invite.required = tab === 'register';
    pass.autocomplete = tab === 'register' ? 'new-password' : 'current-password';
    submit.textContent = tab === 'register' ? 'Create account' : 'Log in';
    err.textContent = '';
  };

  const form = h('form', {
    class: 'auth-form',
    onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const body = { username: user.value.trim(), password: pass.value };
        if (tab === 'register') body.invite = invite.value.trim();
        await api('POST', `/api/auth/${tab}`, body);
        onDone();
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  tabs,
  h('label', { class: 'field' }, h('span', {}, 'Username'), user),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pass),
  inviteRow, err, submit);
  sync();
  return form;
}

export function openAuthModal(reason) {
  const m = modal('Account', h('div', {},
    reason ? h('p', { class: 'muted' }, reason) : null,
    authForm(() => location.reload())));
  return m;
}

export function openInvitesModal() {
  const list = h('div', { class: 'invite-list' });
  const uses = h('input', { type: 'number', min: 1, max: 1000, value: 1 });
  const ttl = h('select', {},
    ...[[24, '1 day'], [168, '7 days'], [720, '30 days'], [0, 'never']].map(([v, l]) => h('option', { value: v, selected: v === 168 }, l)));

  async function refresh() {
    try {
      const rows = await api('GET', '/api/admin/invites');
      list.replaceChildren(...(rows.length ? rows.map((r) => h('div', { class: 'invite-row' },
        h('code', {}, r.code),
        h('span', { class: 'muted' }, `${r.usedCount}/${r.maxUses} used`),
        h('span', { class: 'muted' }, r.expiresAt ? `exp ${new Date(r.expiresAt).toLocaleDateString()} ${clock(r.expiresAt)}` : 'no expiry'),
        copyButton(() => r.code, 'Copy code'),
        h('button', {
          type: 'button', class: 'icon-btn danger', title: 'Revoke', 'aria-label': 'Revoke',
          onClick: async () => { await api('DELETE', `/api/admin/invites/${encodeURIComponent(r.code)}`); refresh(); },
        }, icon('trash')),
      )) : [h('p', { class: 'muted' }, 'No invite codes yet.')]));
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  const form = h('form', {
    class: 'row gap',
    onSubmit: async (e) => {
      e.preventDefault();
      try {
        const { code } = await api('POST', '/api/admin/invites', { maxUses: Number(uses.value), ttlHours: Number(ttl.value) });
        toast(`Invite created: ${code}`, 'ok');
        refresh();
      } catch (ex) {
        toast(ex.message, 'error');
      }
    },
  },
  h('label', { class: 'field compact' }, h('span', {}, 'Uses'), uses),
  h('label', { class: 'field compact' }, h('span', {}, 'Valid'), ttl),
  h('button', { type: 'submit', class: 'btn primary' }, icon('plus'), 'Generate'));

  modal('Invite codes', h('div', {}, form, list), { wide: true });
  refresh();
}

export function openPasswordModal() {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 });
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, 'Change password');
  let m;
  const form = h('form', {
    class: 'auth-form',
    onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (next.value !== confirm.value) {
        err.textContent = 'New passwords do not match';
        return;
      }
      submit.disabled = true;
      try {
        await api('POST', '/api/auth/password', { current: current.value, next: next.value });
        m.close();
        toast('Password changed; other sessions were signed out', 'ok');
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('label', { class: 'field' }, h('span', {}, 'Current password'), current),
  h('label', { class: 'field' }, h('span', {}, 'New password'), next),
  h('label', { class: 'field' }, h('span', {}, 'Confirm new password'), confirm),
  err, submit);
  m = modal('Change password', form);
}

export async function logout() {
  await api('POST', '/api/auth/logout');
  location.reload();
}

/** Header chip: shows identity and opens the relevant account actions. */
export function accountChip(me) {
  if (!me.isUser) {
    return h('button', { type: 'button', class: 'chip glass-chip', title: 'Log in to upload files', onClick: () => openAuthModal() },
      icon('user'), h('span', { class: 'chip-text' }, me.name), h('span', { class: 'chip-tag' }, 'guest'));
  }
  return h('button', {
    type: 'button', class: 'chip glass-chip member',
    onClick: () => {
      const m = modal(me.name, h('div', { class: 'stack' },
        h('p', { class: 'muted' }, me.role === 'admin' ? 'Administrator' : 'Member: you can upload files.'),
        me.role === 'admin' ? h('button', { type: 'button', class: 'btn', onClick: () => { m.close(); openInvitesModal(); } }, icon('key'), 'Manage invite codes') : null,
        me.role === 'admin' ? h('button', { type: 'button', class: 'btn', onClick: () => { m.close(); openChannelsModal(); } }, icon('users'), 'Hosted channels') : null,
        h('button', { type: 'button', class: 'btn', onClick: () => { m.close(); openPasswordModal(); } }, icon('lock'), 'Change password'),
        h('button', { type: 'button', class: 'btn danger', onClick: logout }, icon('logout'), 'Log out')));
    },
  }, icon('user'), h('span', { class: 'chip-text' }, me.name), h('span', { class: 'chip-tag' }, me.role === 'admin' ? 'admin' : 'member'));
}
