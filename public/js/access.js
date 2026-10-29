import { barChart } from './charts.js';
import { ago, dateTime, duration, h, kindDot, morph, num, PEER_LABEL } from './lib.js';
import { store } from './store.js';

let histKind = 'all';

const KIND_TEXT = {
  self: 'esta máquina',
  local: 'esta máquina',
  tailnet: 'tailnet',
  docker: 'container',
  lan: 'rede local',
  internet: 'internet',
};

function who(peer) {
  return h(
    'span',
    { class: 'who' },
    kindDot(peer.kind),
    h('strong', { title: peer.ip }, peer.label),
    h('span', { class: 'who-kind' }, [KIND_TEXT[peer.kind], peer.detail].filter(Boolean).join(', ')),
  );
}

function liveRows(list) {
  return list.map((c) =>
    h(
      'div',
      { class: 'live-row', dataset: { key: `${c.service}|${c.peer.kind}|${c.peer.label}|${c.via ?? ''}` } },
      who(c.peer),
      h('span', { class: 'target' }, h('b', null, c.serviceName), ` na porta ${c.port}`, c.via ? `, via ${c.via}` : ''),
      h('span', { class: 'muted num' }, c.count > 1 ? `${c.count} conexões` : '1 conexão'),
    ),
  );
}

function renderLive() {
  const data = store.access;
  if (!data) return;
  const live = [...data.live].sort((a, b) => Number(a.peer.kind === 'local' || a.peer.kind === 'self') - Number(b.peer.kind === 'local' || b.peer.kind === 'self'));
  const remote = live.filter((c) => c.peer.kind !== 'local' && c.peer.kind !== 'self').length;
  document.getElementById('live-note').textContent = live.length ? `${remote} de fora desta máquina` : '';
  morph(document.getElementById('live'), live.length ? liveRows(live) : h('p', { class: 'empty' }, 'Ninguém conectado agora. Quando alguém abrir um dos seus serviços, aparece aqui.'));
}

function renderDevices() {
  const devices = store.access?.devices ?? [];
  morph(
    document.getElementById('devices'),
    devices.length
      ? devices.map((d) =>
          h(
            'div',
            { class: 'device', dataset: { key: d.dnsName } },
            h('span', { class: ['state', d.online ? 'running' : 'stopped'] }, h('span', { class: ['dot', d.online ? 'k-tailnet' : ''], style: d.online ? undefined : { background: 'var(--ink-3)' } })),
            h('span', { class: 'who' }, h('strong', null, d.name), h('span', { class: 'who-kind' }, [d.self ? 'esta máquina' : null, d.os].filter(Boolean).join(', '))),
            h('span', { class: 'muted' }, d.online ? 'online' : d.lastSeen ? `visto ${ago(Date.parse(d.lastSeen))}` : 'offline'),
          ),
        )
      : h('p', { class: 'empty' }, 'Tailscale não está disponível nesta máquina.'),
  );
}

// ------------------------------------------------------------ visitas (access logs)

function rank(items, fmt = (x) => x.name) {
  if (!items.length) return h('p', { class: 'help' }, 'Sem dados.');
  return h(
    'ol',
    { class: 'rank' },
    items.map((i) => h('li', null, h('span', { class: 'label', title: fmt(i) }, fmt(i)), h('span', { class: 'n' }, num(i.n)))),
  );
}

const statusClass = (s) => (s >= 500 ? 's5' : s >= 400 ? 's4' : '');

/** Cartão com o resumo das visitas lidas do access log de um serviço. */
export function requestCard(title, data, key, { compact = false } = {}) {
  if (!data.available) return h('div', { class: 'req-card', dataset: { key } }, h('div', { class: 'req-head' }, h('h3', null, title)), h('p', { class: 'help' }, data.reason));
  if (!data.total) return h('div', { class: 'req-card', dataset: { key } }, h('div', { class: 'req-head' }, h('h3', null, title)), h('p', { class: 'help' }, `Nenhuma linha no formato de access log (nginx/Apache) nas últimas ${num(data.scanned)} linhas.`));
  const errors = data.status.clientError + data.status.serverError;
  const chartId = `req-${key}`;
  return h(
    'div',
    { class: 'req-card', dataset: { key } },
    h('div', { class: 'req-head' }, h('h3', null, title), h('span', { class: 'section-note' }, `${num(data.total)} requisições nas últimas ${num(data.scanned)} linhas de log`)),
    data.hint && h('p', { class: 'help', style: { 'margin-bottom': '14px' } }, data.hint),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Visitantes'), h('div', { class: 'value' }, num(data.visitors))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Páginas vistas'), h('div', { class: 'value' }, num(data.pages))),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Respostas com erro'), h('div', { class: 'value' }, num(errors))),
    ),
    h('p', { class: 'mini-title' }, 'Páginas vistas por hora, últimas 24 horas'),
    h('div', { class: 'chart', style: { height: '110px', 'margin-bottom': '18px' }, dataset: { bars: chartId }, 'data-skip-morph': '' }),
    h(
      'div',
      { class: 'req-grid' },
      h('div', null, h('p', { class: 'mini-title' }, 'Páginas mais vistas'), rank(data.topPages)),
      h('div', null, h('p', { class: 'mini-title' }, 'Dispositivos'), rank(data.devices)),
      !compact && h('div', null, h('p', { class: 'mini-title' }, 'De onde vêm'), rank(data.clients)),
    ),
    data.recent.length > 0 &&
      h(
        'details',
        { style: { 'margin-top': '16px' } },
        h('summary', { class: 'muted' }, `Últimas ${Math.min(data.recent.length, 40)} visitas`),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, h('th', null, 'Quando'), h('th', null, 'Quem'), h('th', null, 'Página'), h('th', { class: 'num' }, 'Status'), h('th', null, 'Dispositivo'))),
            h(
              'tbody',
              null,
              data.recent.slice(0, 40).map((r) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'num', title: new Date(r.t).toLocaleString('pt-BR') }, ago(r.t)),
                  h('td', null, h('span', { class: 'who' }, kindDot(r.kind), r.client)),
                  h('td', { class: 'mono' }, `${r.method === 'GET' ? '' : `${r.method} `}${r.path.length > 70 ? `${r.path.slice(0, 70)}…` : r.path}`),
                  h('td', { class: ['num', 'status-code', statusClass(r.status)] }, String(r.status)),
                  h('td', null, r.device),
                ),
              ),
            ),
          ),
        ),
      ),
  );
}

function drawRequestCharts(root, entries) {
  for (const { key, data } of entries) {
    if (!data.available) continue;
    const host = root.querySelector(`[data-bars="${CSS.escape(`req-${key}`)}"]`);
    if (!host) continue;
    const bars = data.perHour.map((v, i) => ({ v, label: i === 23 ? 'na última hora' : `há ${23 - i} h` }));
    barChart(host, bars, {
      format: (v) => `${num(v)} ${v === 1 ? 'página' : 'páginas'}`,
      label: 'Páginas vistas por hora',
      xLabels: [
        { i: 0, text: 'há 24 h' },
        { i: 12, text: 'há 12 h' },
        { i: 23, text: 'agora' },
      ],
    });
  }
}

function renderRequests() {
  const root = document.getElementById('requests');
  const list = store.requests;
  if (!list) return;
  if (!list.length) {
    morph(root, h('p', { class: 'empty' }, 'Nenhum servidor com access log rodando. Containers nginx, Apache e Caddy entram aqui sozinhos; para outros, marque "Ler os logs como access log" nos detalhes do serviço.'));
    return;
  }
  morph(
    root,
    list.map((r) => requestCard([r.project, r.name].filter(Boolean).join(' / '), r.data, r.key)),
  );
  drawRequestCharts(root, list);
}

// ------------------------------------------------------------ histórico

function historyTable(entries) {
  if (!entries.length) return h('p', { class: 'empty' }, 'Nenhuma conexão registrada com esse filtro.');
  const sampleSec = (store.access?.sampleMs ?? 3000) / 1000;
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h('tr', null, h('th', null, 'Quem'), h('th', null, 'Serviço'), h('th', null, 'Primeira vez'), h('th', null, 'Última vez'), h('th', { class: 'num' }, 'Tempo conectado'), h('th', { class: 'num' }, 'Pico')),
    ),
    h(
      'tbody',
      null,
      entries.slice(0, 200).map((e) =>
        h(
          'tr',
          { dataset: { key: `${e.service}|${e.kind}|${e.label}` } },
          h('td', null, h('span', { class: 'who' }, kindDot(e.kind), h('strong', { title: e.ip }, e.label), h('span', { class: 'who-kind' }, KIND_TEXT[e.kind]))),
          h('td', null, e.serviceName),
          h('td', null, dateTime(e.first)),
          h('td', null, ago(e.last)),
          h('td', { class: 'num' }, `~${duration(e.samples * sampleSec)}`),
          h('td', { class: 'num' }, String(e.peak)),
        ),
      ),
    ),
  );
}

function renderHistory() {
  const all = store.access?.history ?? [];
  const entries = all.filter((e) => histKind === 'all' || (histKind === 'internet' ? e.kind === 'internet' : e.kind !== 'local' && e.kind !== 'self'));
  morph(document.getElementById('history'), historyTable(entries));
}

export function renderAccess() {
  renderLive();
  renderDevices();
  renderRequests();
  renderHistory();
}

/** Conteúdo da aba Acessos no painel de um serviço. */
export function renderAccessFor(svc, req) {
  const live = (store.access?.live ?? []).filter((c) => c.service === svc.key);
  const hist = (store.access?.history ?? []).filter((e) => e.service === svc.key);
  const parts = [
    h('h3', { class: 'subhead' }, 'Conectados agora'),
    live.length ? h('div', { class: 'live' }, liveRows(live)) : h('p', { class: 'help' }, 'Ninguém conectado neste momento.'),
    h('h3', { class: 'subhead' }, 'Histórico de conexões'),
    h('div', { class: 'table-wrap' }, historyTable(hist)),
    h('h3', { class: 'subhead' }, 'Visitas pelo access log'),
  ];
  if (!req) parts.push(h('button', { class: 'btn', type: 'button', dataset: { action: 'load-requests' } }, 'Procurar visitas nos logs'));
  else if (req.loading) parts.push(h('p', { class: 'help' }, 'Lendo os logs…'));
  else {
    parts.push(requestCard(svc.name, req.data, `d-${svc.key}`, { compact: true }));
    queueMicrotask(() => {
      const root = document.getElementById('drawer-access');
      drawRequestCharts(root, [{ key: `d-${svc.key}`, data: req.data }]);
    });
  }
  return parts;
}

document.getElementById('hist-kind')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  histKind = b.dataset.kind;
  for (const x of e.currentTarget.children) x.setAttribute('aria-checked', String(x === b));
  renderHistory();
});
