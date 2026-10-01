import { h } from './ui.js';
import { themeButton } from './theme.js';
import { accountChip } from './account.js';

export function topbar(me, ...middle) {
  return h('header', { class: 'topbar glass' },
    h('a', { class: 'brand', href: '/', 'aria-label': 'WanDrop home' }, h('span', { class: 'brand-mark' }, 'w/'), h('span', { class: 'brand-name' }, 'wandrop')),
    h('div', { class: 'topbar-mid' }, ...middle),
    h('div', { class: 'topbar-end' }, themeButton(), accountChip(me)));
}
