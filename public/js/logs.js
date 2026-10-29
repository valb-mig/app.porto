// Visualizador de logs ao vivo do painel lateral (SSE em /api/logs).
import { h } from './lib.js';

const MAX_LINES = 5000;
const ERROR_RE = /\b(error|erro|fatal|exception|panic|failed|falhou|traceback|uncaught|ECONN\w+|segfault)\b/i;
// SGR (cores) em m[1]; os demais escapes (cursor, OSC) só são removidos.
const ESC_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
const stripAnsi = (t) => t.replace(ESC_RE, '');

function ansiNodes(text) {
  const out = [];
  const cls = new Set();
  let fg = null;
  let last = 0;
  const seg = (t) => (t ? (cls.size || fg ? h('span', { class: [...cls, fg && `a-${fg}`] }, t) : t) : null);
  for (const m of text.matchAll(ESC_RE)) {
    out.push(seg(text.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        cls.clear();
        fg = null;
      } else if (c === 1) cls.add('a-b');
      else if (c === 2) cls.add('a-d');
      else if (c === 3) cls.add('a-i');
      else if (c === 4) cls.add('a-u');
      else if (c === 22) {
        cls.delete('a-b');
        cls.delete('a-d');
      } else if (c === 23) cls.delete('a-i');
      else if (c === 24) cls.delete('a-u');
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = c;
      else if (c === 39) fg = null;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  out.push(seg(text.slice(last)));
  return out;
}

function highlight(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
    out.push(text.slice(i, j), h('mark', null, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let es = null;
let lines = [];
let paused = false;
let pending = [];
let serviceName = '';
let currentKey = null;
const el = (id) => document.getElementById(id);

const isError = (l) => l.s === 'err' || ERROR_RE.test(l.m);

function matches(l) {
  const q = el('log-filter').value.trim().toLowerCase();
  if (el('log-errors').checked && !isError(l)) return false;
  return !q || stripAnsi(l.m).toLowerCase().includes(q);
}

function lineNode(l) {
  const q = el('log-filter').value.trim().toLowerCase();
  const body = q ? highlight(stripAnsi(l.m), q) : ansiNodes(l.m);
  return h(
    'div',
    { class: ['ln', isError(l) && 'err'] },
    h('span', { class: 'ts', title: l.t ? new Date(l.t).toLocaleString('pt-BR') : undefined }, l.t ? timeFmt.format(l.t) : ''),
    h('span', null, body),
  );
}

const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 40;

function appendLines(batch) {
  const box = el('log');
  const stick = nearBottom(box);
  const frag = document.createDocumentFragment();
  for (const l of batch) if (matches(l)) frag.append(lineNode(l));
  box.append(frag);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
  el('log-jump').hidden = nearBottom(box);
}

function rerender() {
  const box = el('log');
  box.replaceChildren();
  appendLines(lines);
  box.scrollTop = box.scrollHeight;
  if (!box.childElementCount && lines.length) box.append(h('div', { class: 'note' }, 'Nenhuma linha corresponde ao filtro.'));
}

function note(text, action) {
  el('log').append(h('div', { class: 'note' }, text, action && [' ', action]));
  el('log').scrollTop = el('log').scrollHeight;
}

export function openLogs(key, name) {
  closeLogs();
  currentKey = key;
  serviceName = name;
  lines = [];
  pending = [];
  el('log').replaceChildren(h('div', { class: 'note' }, 'Conectando aos logs…'));
  el('log-source').textContent = '';
  es = new EventSource(`/api/logs?key=${encodeURIComponent(key)}&tail=500`);
  let first = true;
  es.addEventListener('source', (e) => {
    el('log-source').textContent = JSON.parse(e.data).label;
  });
  es.addEventListener('lines', (e) => {
    const batch = JSON.parse(e.data);
    if (first) {
      el('log').replaceChildren();
      first = false;
    }
    lines.push(...batch);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    if (paused) pending.push(...batch);
    else appendLines(batch);
  });
  es.addEventListener('unavailable', (e) => {
    es.close();
    el('log').replaceChildren(h('div', { class: 'note' }, JSON.parse(e.data).reason));
  });
  es.addEventListener('end', (e) => {
    es.close();
    const err = JSON.parse(e.data).error;
    if (first) el('log').replaceChildren();
    note(err ? `O stream de logs terminou: ${err}` : 'O stream de logs terminou (o serviço parou?).', h('button', { class: 'btn ghost', type: 'button', dataset: { action: 'logs-reconnect' } }, 'Reconectar'));
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) note('Conexão com o servidor perdida.');
  };
}

export function closeLogs() {
  es?.close();
  es = null;
  currentKey = null;
}

export const reconnectLogs = () => currentKey && openLogs(currentKey, serviceName);

export function initLogs() {
  el('log-filter').addEventListener('input', rerender);
  el('log-errors').addEventListener('change', rerender);
  el('log-wrap').addEventListener('change', (e) => el('log').classList.toggle('nowrap', !e.target.checked));
  el('log-pause').addEventListener('click', (e) => {
    paused = !paused;
    e.currentTarget.setAttribute('aria-pressed', String(paused));
    e.currentTarget.textContent = paused ? 'Continuar' : 'Pausar';
    if (!paused) {
      appendLines(pending);
      pending = [];
    }
  });
  el('log-clear').addEventListener('click', () => {
    lines = [];
    el('log').replaceChildren();
  });
  el('log-download').addEventListener('click', () => {
    const text = lines.map((l) => `${l.t ? new Date(l.t).toISOString() : ''}\t${l.s}\t${stripAnsi(l.m)}`).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `${serviceName || 'servico'}-logs.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  el('log').addEventListener('scroll', () => (el('log-jump').hidden = nearBottom(el('log'))));
  el('log-jump').addEventListener('click', () => {
    el('log').scrollTop = el('log').scrollHeight;
  });
}
