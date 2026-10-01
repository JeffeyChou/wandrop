import { api } from './api.js';
import { h, iconButton, modal, toast, clock, remaining, bytes, copyButton, hueOf } from './ui.js';

const stamp = (ts) => `${new Date(ts).toLocaleDateString()} ${clock(ts)}`;

/** Short "Browser version · OS" label from a User-Agent string. */
export function describeAgent(ua) {
  if (!ua) return 'unknown';
  const browser = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d]+)/], ['Opera', /(?:OPR|Opera)\/([\d]+)/], ['Samsung', /SamsungBrowser\/([\d]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d]+)/], ['Chrome', /(?:Chrome|CriOS)\/([\d]+)/], ['Safari', /Version\/([\d.]+).*Safari/],
    ['curl', /curl\/([\d.]+)/],
  ].find(([, re]) => re.test(ua));
  const os = [
    ['iOS', /iPhone|iPad|iPod/], ['Android', /Android/], ['Windows', /Windows/], ['macOS', /Mac OS X|Macintosh/],
    ['ChromeOS', /CrOS/], ['Linux', /Linux/],
  ].find(([, re]) => re.test(ua));
  const b = browser ? `${browser[0]} ${ua.match(browser[1])[1]}` : 'Other';
  return os ? `${b} · ${os[0]}` : b;
}

function table(head, rows) {
  return h('div', { class: 'table-wrap admin-table' },
    h('table', {},
      h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))),
      h('tbody', {}, ...rows)));
}

/** Everyone who opened a channel, with IP, time zone and browser. */
export function openVisitsModal(channelId) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const m = modal(`Visitors of #${channelId}`, body, { wide: true });
  m.card.classList.add('xwide');

  async function refresh() {
    try {
      const rows = await api('GET', `/api/admin/channels/${channelId}/visits`);
      const people = new Set(rows.map((r) => r.tag)).size;
      body.replaceChildren(
        h('div', { class: 'row gap admin-summary' },
          h('span', { class: 'muted' }, `${people} visitor${people === 1 ? '' : 's'} · ${rows.length} distinct IP / browser combination${rows.length === 1 ? '' : 's'}`),
          h('span', { class: 'grow' }),
          iconButton('refresh', 'Refresh', refresh)),
        h('p', { class: 'muted small' }, 'Recorded on every page load and kept until the channel is destroyed, even if the visitor never sent anything.'),
        rows.length ? table(['Visitor', 'IP', 'Time zone', 'Browser', 'Language', 'Loads', 'First seen', 'Last seen'], rows.map((r) => h('tr', {},
          h('td', {}, h('span', { class: 'who' },
            h('span', { class: `avatar sm ${r.isUser ? 'member' : ''}`, style: { '--h': hueOf(r.tag) } }, r.name.slice(0, 1).toUpperCase()),
            h('span', {}, r.name),
            r.isUser ? h('span', { class: 'badge' }, 'member') : null,
            r.isOwner ? h('span', { class: 'badge' }, 'owner') : null)),
          h('td', { class: 'mono' }, h('span', { class: 'who' }, r.ip || '–', r.country ? h('span', { class: 'muted' }, r.country) : null, r.ip ? copyButton(() => r.ip, 'Copy IP') : null)),
          h('td', {}, r.timezone || '–'),
          h('td', { title: r.userAgent }, describeAgent(r.userAgent)),
          h('td', {}, r.language || '–'),
          h('td', { class: 'num' }, r.visits),
          h('td', { class: 'nowrap' }, stamp(r.firstSeen)),
          h('td', { class: 'nowrap' }, stamp(r.lastSeen)))))
          : h('p', { class: 'muted' }, 'Nobody has opened this channel yet.'));
    } catch (e) {
      body.replaceChildren(h('p', { class: 'form-error' }, e.message));
    }
  }
  refresh();
}

/** Every live channel on this server with its size and activity. */
export function openChannelsModal() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const m = modal('Hosted channels', body, { wide: true });
  m.card.classList.add('xwide');

  async function refresh() {
    try {
      const { channels, serverTime } = await api('GET', '/api/admin/channels');
      const total = channels.reduce((s, c) => s + c.messageBytes + c.fileBytes + c.uploadBytes, 0);
      const msgs = channels.reduce((s, c) => s + c.messages, 0);
      body.replaceChildren(
        h('div', { class: 'row gap admin-summary' },
          h('span', { class: 'muted' }, `${channels.length} channel${channels.length === 1 ? '' : 's'} · ${msgs} message${msgs === 1 ? '' : 's'} · ${bytes(total)} stored`),
          h('span', { class: 'grow' }),
          iconButton('refresh', 'Refresh', refresh)),
        channels.length ? table(['Code', 'Owner', 'Created', 'Expires in', 'Messages', 'Files', 'Storage', 'Visitors', ''], channels.map((c) => {
          const storage = c.messageBytes + c.fileBytes + c.uploadBytes;
          return h('tr', {},
            h('td', {}, h('span', { class: 'who' }, h('a', { href: `/c/${c.id}`, class: 'mono code-link' }, c.id), copyButton(() => c.id, 'Copy code'))),
            h('td', {}, c.ownerName || '–', h('span', { class: 'muted' }, c.ownerKind === 'user' ? ' (member)' : ' (guest)')),
            h('td', { class: 'nowrap' }, stamp(c.createdAt)),
            h('td', { class: 'nowrap' }, remaining(c.expiresAt - serverTime)),
            h('td', { class: 'num', title: `${bytes(c.messageBytes)} of text` }, c.messages),
            h('td', { class: 'num', title: c.uploads ? `${c.uploads} unfinished upload(s), ${bytes(c.uploadBytes)} received` : null },
              c.files, c.uploads ? h('span', { class: 'muted' }, ` +${c.uploads}`) : null),
            h('td', {
              class: 'num nowrap',
              title: `text ${bytes(c.messageBytes)} · files ${bytes(c.fileBytes)}${c.uploads ? ` · partial uploads ${bytes(c.uploadBytes)}` : ''}`,
            }, bytes(storage)),
            h('td', { class: 'num' }, c.visitors, c.online ? h('span', { class: 'online', title: 'Online now' }, ` ● ${c.online}`) : null),
            h('td', {}, iconButton('users', 'Visitor log', () => openVisitsModal(c.id))));
        })) : h('p', { class: 'muted' }, 'No live channels.'));
    } catch (e) {
      toast(e.message, 'error');
      body.replaceChildren(h('p', { class: 'form-error' }, e.message));
    }
  }
  refresh();
}
