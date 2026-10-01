import MarkdownIt from 'markdown-it';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { h, copyButton } from './ui.js';

const renderTex = (tex, displayMode) => katex.renderToString(tex, {
  displayMode, throwOnError: false, strict: 'ignore', trust: false, maxSize: 20, maxExpand: 500, output: 'htmlAndMathml',
});

/** markdown-it plugin: $inline$, $$display$$ (inline or block), \( \) and \[ \]. */
function mathPlugin(md) {
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    let open, close, display;
    if (src.startsWith('$$', pos)) [open, close, display] = ['$$', '$$', true];
    else if (src[pos] === '$') [open, close, display] = ['$', '$', false];
    else if (src.startsWith('\\(', pos)) [open, close, display] = ['\\(', '\\)', false];
    else if (src.startsWith('\\[', pos)) [open, close, display] = ['\\[', '\\]', true];
    else return false;

    const start = pos + open.length;
    if (open === '$' && /\s/.test(src[start] || ' ')) return false; // "$ 5" is not math
    let end = start;
    while ((end = src.indexOf(close, end)) !== -1) {
      if (src[end - 1] !== '\\') break;
      end += 1;
    }
    if (end === -1 || end === start) return false;
    if (open === '$' && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || ''))) return false;
    if (!silent) {
      const token = state.push(display ? 'math_display_inline' : 'math_inline', 'math', 0);
      token.content = src.slice(start, end);
    }
    state.pos = end + close.length;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
    const lineText = (n) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
    const first = lineText(startLine);
    const delim = first.startsWith('$$') ? ['$$', '$$'] : first.startsWith('\\[') ? ['\\[', '\\]'] : null;
    if (!delim) return false;
    let body = first.slice(2);
    let line = startLine;
    let found = body.trimEnd().endsWith(delim[1]);
    if (found) body = body.trimEnd().slice(0, -2);
    while (!found && ++line < endLine) {
      const t = lineText(line);
      if (t.trimEnd().endsWith(delim[1])) {
        body += `\n${t.trimEnd().slice(0, -2)}`;
        found = true;
      } else body += `\n${t}`;
    }
    if (!found || !body.trim()) return false;
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.content = body;
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  });

  md.renderer.rules.math_inline = (tokens, i) => renderTex(tokens[i].content, false);
  md.renderer.rules.math_display_inline = (tokens, i) => renderTex(tokens[i].content, true);
  md.renderer.rules.math_block = (tokens, i) => `<div class="math-block">${renderTex(tokens[i].content, true)}</div>`;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false }).use(mathPlugin);

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

export function renderMarkdown(source) {
  const html = DOMPurify.sanitize(md.render(source), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['id'],
  });
  const root = h('div', { class: 'md', html });
  // Code blocks get their own copy button; wide tables scroll horizontally.
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.textContent;
    pre.replaceWith(h('div', { class: 'code-wrap' }, pre.cloneNode(true), copyButton(() => code, 'Copy code')));
  }
  for (const table of root.querySelectorAll('table')) {
    const wrap = h('div', { class: 'table-wrap' });
    table.replaceWith(wrap);
    wrap.append(table);
  }
  return root;
}

export function renderPlain(source) {
  return h('pre', { class: 'plain' }, source);
}
