// Utilitários do front: criação de DOM, atualização incremental, ícones, formatação e API.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Cria um elemento. Texto sempre entra como nó de texto (nunca innerHTML), então nomes
 * vindos de logs, containers e sites não viram HTML.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) dv !== undefined && (el.dataset[dk] = dv);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Substitui o conteúdo de `target` pelo de `next` reaproveitando os nós existentes.
 * Filhos com `data-key` são casados pela chave; elementos com `data-skip-morph` mantêm o
 * conteúdo atual (gráficos desenhados à parte).
 */
export function morph(target, ...nextChildren) {
  const next = document.createElement(target.tagName);
  append(next, nextChildren);
  morphChildren(target, next);
}

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.tagName === b.tagName && (a.dataset.key ?? null) === (b.dataset.key ?? null);
}

function morphNode(from, to) {
  if (from.nodeType === 3 || from.nodeType === 8) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) === value) continue;
    // A CSP bloqueia setAttribute('style'); pela CSSOM é permitido.
    if (name === 'style') from.style.cssText = to.style.cssText;
    else from.setAttribute(name, value);
  }
  if (from.hasAttribute('data-skip-morph')) return;
  morphChildren(from, to);
}

function morphChildren(from, to) {
  const keyed = new Map();
  for (const n of from.childNodes) if (n.nodeType === 1 && n.dataset.key) keyed.set(n.dataset.key, n);
  let cursor = from.firstChild;
  for (const nn of [...to.childNodes]) {
    let match = null;
    const key = nn.nodeType === 1 ? nn.dataset.key : undefined;
    if (key) match = keyed.get(key) ?? null;
    else if (cursor && sameKind(cursor, nn)) match = cursor;
    if (match) {
      if (match !== cursor) from.insertBefore(match, cursor);
      else cursor = cursor.nextSibling;
      morphNode(match, nn);
      if (key) keyed.delete(key);
    } else from.insertBefore(nn, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

// ------------------------------------------------------------ ícones (traço 1.8, 24×24)

const ICONS = {
  search: ['c:11,11,7', 'M20 20l-3.5-3.5'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  play: ['M7 4.5v15l12-7.5z'],
  stop: ['M6.5 6.5h11v11h-11z'],
  restart: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  zap: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  pin: ['M12 16v6', 'M8 3h8l-1.5 6.5L18 14H6l3.5-4.5z'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'c:12,12,3'],
  eyeOff: ['M3 3l18 18', 'M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.8', 'M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1.1'],
  share: ['c:6,12,2.5', 'c:18,6,2.5', 'c:18,18,2.5', 'M8.2 10.8l7.6-3.6', 'M8.2 13.2l7.6 3.6'],
  unshare: ['c:6,12,2.5', 'c:18,6,2.5', 'M8.2 10.8l7.6-3.6', 'M14 15l6 6', 'M20 15l-6 6'],
  pencil: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M9.5 7V4h5v3', 'M6 7l1 13h10l1-13'],
  plus: ['M12 5v14', 'M5 12h14'],
  copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  alert: ['M12 3.5L2.5 20h19z', 'M12 10v4.5', 'M12 17.5v.01'],
  circle: ['c:12,12,5'],
  ring: ['c:12,12,5'],
  half: ['c:12,12,6', 'M12 6a6 6 0 0 1 0 12z'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  chevron: ['M9 6l6 6-6 6'],
  grip: ['c:9,7,1', 'c:15,7,1', 'c:9,12,1', 'c:15,12,1', 'c:9,17,1', 'c:15,17,1'],
};

export function icon(name, cls = 'icon') {
  const svg = s('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  for (const d of ICONS[name] ?? []) {
    if (d.startsWith('c:')) {
      const [cx, cy, r] = d.slice(2).split(',');
      svg.append(s('circle', { cx, cy, r }));
    } else svg.append(s('path', { d }));
  }
  return svg;
}

// ------------------------------------------------------------ formatação pt-BR

const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
export const num = (n) => nf0.format(n);
export const num1 = (n) => nf1.format(n);
export const pct = (n) => (n === undefined || n === null || Number.isNaN(n) ? '—' : `${n < 10 ? nf1.format(n) : nf0.format(n)}%`);

export function bytes(n) {
  if (n === undefined || n === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? nf1.format(n) : nf0.format(n)} ${units[i]}`;
}

export const rate = (n) => `${bytes(n)}/s`;

export function duration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} ${d === 1 ? 'dia' : 'dias'}${hh ? ` e ${hh} h` : ''}`;
  if (hh) return `${hh} h ${m} min`;
  if (m) return `${m} min`;
  return `${sec} s`;
}

export function ago(t) {
  if (!t) return '—';
  const sec = (Date.now() - t) / 1000;
  if (sec < 10) return 'agora';
  if (sec < 60) return `há ${Math.floor(sec)} s`;
  if (sec < 3600) return `há ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `há ${Math.floor(sec / 3600)} h`;
  const d = Math.floor(sec / 86400);
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const clockTime = (t) => timeFmt.format(t);
export const dateTime = (t) => (t ? dateTimeFmt.format(t) : '—');

/** Normaliza pra busca: minúsculas e sem acentos. */
export const fold = (str) =>
  String(str ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// ------------------------------------------------------------ API

export class ApiError extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Porto': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Erro ${res.status}`);
  return data;
}

// ------------------------------------------------------------ avisos e tooltip

export function toast(message, kind = 'ok') {
  const el = h('div', { class: ['toast', kind], role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'alert' : 'check'), h('span', null, message));
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
}

const tip = () => document.getElementById('tooltip');

export function showTooltip(x, y, ...content) {
  const el = tip();
  el.replaceChildren(...content);
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, x + 14);
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
}

export const hideTooltip = () => (tip().hidden = true);

// ------------------------------------------------------------ peças visuais reutilizadas

const STATE_ICON = { running: 'circle', stopped: 'ring', failed: 'alert', starting: 'half' };

export function stateMark(state, text) {
  return h('span', { class: ['state', state] }, icon(STATE_ICON[state] ?? 'ring'), text);
}

export const PEER_LABEL = {
  self: 'Esta máquina',
  local: 'Esta máquina',
  tailnet: 'Tailnet',
  docker: 'Docker',
  lan: 'Rede local',
  internet: 'Internet',
  public: 'Internet',
};

export const kindDot = (kind) => h('span', { class: ['dot', `k-${kind}`], 'aria-hidden': 'true' });

/** Favicons que já falharam não são pedidos de novo (evita piscar a cada atualização). */
const failedIcons = new Set();
const darkIcons = new Set();
const checkedIcons = new Set();

export function favicon(url, label) {
  const src = `/api/favicon?url=${encodeURIComponent(url)}`;
  if (failedIcons.has(src)) return monogram(label);
  return h('img', { class: ['favicon', darkIcons.has(src) && 'dark-icon'], src, alt: '', loading: 'lazy', dataset: { fallback: label ?? '' } });
}

/**
 * Detecta ícones quase pretos sobre fundo transparente, que sumiriam no tema escuro.
 * Os favicons vêm do próprio Porto (mesma origem), então o canvas pode ler os pixels.
 */
document.addEventListener(
  'load',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('favicon')) return;
    const src = img.getAttribute('src');
    if (checkedIcons.has(src)) return;
    checkedIcons.add(src);
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let lum = 0;
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 40) continue;
        lum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        opaque++;
      }
      if (opaque && opaque < 230 && lum / opaque < 0.3) {
        darkIcons.add(src);
        img.classList.add('dark-icon');
      }
    } catch {
      // SVG sem dimensões ou imagem corrompida: deixa como está.
    }
  },
  true,
);

const monogram = (label) => h('span', { class: 'monogram', 'aria-hidden': 'true' }, (label ?? '?').trim().charAt(0).toUpperCase() || '?');

document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('favicon')) return;
    failedIcons.add(img.getAttribute('src'));
    img.replaceWith(monogram(img.dataset.fallback));
  },
  true,
);

/** Botão de ação perigosa: o primeiro clique arma, o segundo (em até 4 s) confirma. */
const armed = new Map();

export function isArmed(id) {
  const t = armed.get(id);
  return t !== undefined && Date.now() - t < 4000;
}

export function arm(id, onExpire) {
  armed.set(id, Date.now());
  setTimeout(() => {
    if (!isArmed(id)) onExpire?.();
  }, 4100);
}

export const disarm = (id) => armed.delete(id);

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
