// Gráficos em SVG desenhados à mão: linha (com crosshair) e colunas (com tooltip por barra).
import { h, hideTooltip, s, showTooltip } from './lib.js';

const observed = new WeakSet();

/** Redesenha quando o container muda de tamanho, reaproveitando os últimos dados. */
function watchResize(host, redraw) {
  host._redraw = redraw;
  if (observed.has(host)) return;
  observed.add(host);
  new ResizeObserver(() => host._redraw?.()).observe(host);
}

/** Evita redesenhar (e perder o hover) quando os dados são os mesmos da última vez. */
function unchanged(host, data) {
  const sig = JSON.stringify(data);
  if (host._sig === sig && host.firstChild) return true;
  host._sig = sig;
  return false;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/**
 * Linha temporal de uma série. `points`: [{ t, v }]. Com `axis`, desenha grade e rótulos;
 * sem, vira sparkline. O hover sempre mostra o valor e a hora do ponto mais próximo.
 */
export function lineChart(host, points, { max, format = String, axis = false, color, label = '' } = {}) {
  if (unchanged(host, [points, max, axis, color])) return;
  const draw = () => {
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    if (!w || !hgt) return;
    const padL = axis ? 38 : 2;
    const padR = 6;
    const padT = 6;
    const padB = axis ? 20 : 6;
    const top = max ?? niceMax(Math.max(...points.map((p) => p.v), 0) * 1.1);
    const plotW = w - padL - padR;
    const plotH = hgt - padT - padB;
    const n = points.length;
    const x = (i) => padL + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
    const y = (v) => padT + plotH - (Math.min(v, top) / top) * plotH;
    const svg = s('svg', { viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label });
    if (color) svg.style.setProperty('--series', color);

    if (axis) {
      for (const f of [0, 0.5, 1]) {
        const yy = Math.round(y(top * f)) + 0.5;
        svg.append(s('line', { class: 'grid-line', x1: padL, x2: w - padR, y1: yy, y2: yy }));
        svg.append(s('text', { class: 'axis-text', x: padL - 6, y: yy + 4, 'text-anchor': 'end' }, format(top * f)));
      }
      const spanMin = n > 1 ? Math.round((points[n - 1].t - points[0].t) / 60000) : 0;
      if (spanMin > 0) {
        svg.append(s('text', { class: 'axis-text', x: padL, y: hgt - 4 }, `há ${spanMin} min`));
        svg.append(s('text', { class: 'axis-text', x: w - padR, y: hgt - 4, 'text-anchor': 'end' }, 'agora'));
      }
    }

    if (n) {
      const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
      svg.append(s('path', { class: 'series-area', d: `${d}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` }));
      svg.append(s('path', { class: 'series-line', d }));
      svg.append(s('circle', { class: 'series-dot', cx: x(n - 1), cy: y(points[n - 1].v), r: 4 }));
    }
    const cross = s('line', { class: 'crosshair', y1: padT, y2: padT + plotH, visibility: 'hidden' });
    const hoverDot = s('circle', { class: 'series-dot', r: 4, visibility: 'hidden' });
    svg.append(cross, hoverDot);
    host.replaceChildren(svg);

    host.onpointermove = (e) => {
      if (!n) return;
      const r = host.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - padL) / plotW) * (n - 1))));
      const p = points[i];
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', x(i));
      hoverDot.setAttribute('cy', y(p.v));
      hoverDot.setAttribute('visibility', 'visible');
      showTooltip(e.clientX, e.clientY, h('strong', null, format(p.v)), h('span', null, new Date(p.t).toLocaleTimeString('pt-BR')));
    };
    host.onpointerleave = () => {
      cross.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      hideTooltip();
    };
  };
  watchResize(host, draw);
  draw();
}

/** Colunas com base comum (requisições por hora). `bars`: [{ v, label }]. */
export function barChart(host, bars, { format = String, label = '', xLabels = [] } = {}) {
  if (unchanged(host, bars)) return;
  const draw = () => {
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    if (!w || !hgt) return;
    const padB = 18;
    const padT = 16;
    const plotH = hgt - padB - padT;
    const n = bars.length;
    const slot = w / n;
    const bw = Math.min(24, Math.max(2, slot - 2));
    const top = Math.max(1, ...bars.map((b) => b.v));
    const svg = s('svg', { viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label });
    const base = padT + plotH;
    svg.append(s('line', { class: 'grid-line', x1: 0, x2: w, y1: base + 0.5, y2: base + 0.5 }));
    let maxIdx = -1;
    bars.forEach((b, i) => {
      if (b.v > (bars[maxIdx]?.v ?? 0)) maxIdx = i;
    });
    bars.forEach((b, i) => {
      const bh = (b.v / top) * plotH;
      const bx = i * slot + (slot - bw) / 2;
      const hit = s('rect', { x: i * slot, y: padT, width: slot, height: plotH, fill: 'transparent' });
      let bar = null;
      if (bh > 0) {
        const r = Math.min(4, bw / 2, bh);
        const y0 = base - bh;
        bar = s('path', { class: 'bar', d: `M${bx},${base}V${y0 + r}Q${bx},${y0} ${bx + r},${y0}H${bx + bw - r}Q${bx + bw},${y0} ${bx + bw},${y0 + r}V${base}Z` });
        svg.append(bar);
      }
      hit.addEventListener('pointermove', (e) => {
        bar?.classList.add('hover');
        showTooltip(e.clientX, e.clientY, h('strong', null, format(b.v)), h('span', null, b.label));
      });
      hit.addEventListener('pointerleave', () => {
        bar?.classList.remove('hover');
        hideTooltip();
      });
      svg.append(hit);
    });
    // Rótulo direto só no pico.
    if (maxIdx >= 0 && bars[maxIdx].v > 0) {
      const bx = maxIdx * slot + slot / 2;
      svg.append(s('text', { class: 'axis-text', x: bx, y: base - (bars[maxIdx].v / top) * plotH - 5, 'text-anchor': 'middle' }, format(bars[maxIdx].v)));
    }
    xLabels.forEach(({ i, text }) => {
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      const xx = i === 0 ? 0 : i === n - 1 ? w : i * slot + slot / 2;
      svg.append(s('text', { class: 'axis-text', x: xx, y: hgt - 3, 'text-anchor': anchor }, text));
    });
    host.replaceChildren(svg);
  };
  watchResize(host, draw);
  draw();
}

/** Barra de ocupação: a cor do preenchimento indica severidade, a trilha é o mesmo tom mais claro. */
export function meter(fraction, label, { lowIsBad = false } = {}) {
  const p = Math.max(0, Math.min(1, fraction));
  // Na bateria o ruim é ter pouca carga; no disco e na memória, ter muito uso.
  const severity = lowIsBad ? (p <= 0.15 ? 'bad' : p <= 0.3 ? 'warn' : '') : p >= 0.9 ? 'bad' : p >= 0.75 ? 'warn' : '';
  return h(
    'div',
    { class: ['meter', severity], role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(p * 100), 'aria-label': label },
    h('span', { style: { width: `${(p * 100).toFixed(1)}%` } }),
  );
}
