import { renderAccessFor } from './access.js';
import { ago, api, arm, bytes, disarm, duration, favicon, fold, h, icon, isArmed, kindDot, morph, num, pct, PEER_LABEL, stateMark, toast } from './lib.js';
import { closeLogs, initLogs, openLogs, reconnectLogs } from './logs.js';
import { refresh, refreshActive } from './main.js';
import { onAction, primaryLink, serviceByKey, set, store, ui } from './store.js';

const filter = { text: '', state: 'all', bg: false, hidden: false };

const KIND_LABEL = { docker: 'Container', unit: 'Serviço systemd', process: 'Processo', system: 'Sistema', serve: 'Tailscale serve' };
const SCOPE_TEXT = {
  local: 'só esta máquina',
  all: 'todas as interfaces: rede local e tailnet também alcançam',
  tailnet: 'só pela tailnet',
  lan: 'rede local',
};
const LINK_LABEL = { tailnet: 'tailnet', lan: 'rede local', public: 'internet' };

// ------------------------------------------------------------ peças

const portLabel = (port) => [h('span', { class: 'colon' }, ':'), String(port)];

function subtitle(svc) {
  const title = svc.ports.find((p) => p.http?.title)?.http.title;
  const parts = [KIND_LABEL[svc.kind]];
  if (svc.detail) parts.push(svc.detail);
  else if (title && title !== svc.name) parts.push(title);
  return parts.join(', ');
}

function reachChips(svc) {
  const chips = [];
  for (const l of svc.links) {
    const text = l.kind === 'local' ? l.url.replace(/^https?:\/\//, '') : LINK_LABEL[l.kind];
    chips.push(h('a', { class: 'chip', href: l.url, target: '_blank', rel: 'noopener', title: [l.url, l.note].filter(Boolean).join('\n') }, kindDot(l.kind === 'local' ? 'self' : l.kind), text));
  }
  for (const p of svc.ports) if (p.protocol) chips.push(h('span', { class: 'chip', title: `Porta ${p.port}` }, p.protocol === 'TCP' ? `:${p.port} sem resposta HTTP` : `${p.protocol} :${p.port}`));
  return chips;
}

function usage(svc) {
  if (svc.state !== 'running') return svc.startedAt ? [h('span', null, `parou ${ago(svc.startedAt)}`)] : [];
  return [
    h('div', null, 'CPU ', h('b', { class: 'num' }, pct(svc.cpu)), '  RAM ', h('b', { class: 'num' }, bytes(svc.mem))),
    h('div', null, svc.connections ? `${num(svc.connections)} ${svc.connections === 1 ? 'conexão' : 'conexões'}` : svc.startedAt ? `no ar há ${duration((Date.now() - svc.startedAt) / 1000)}` : ''),
  ];
}

const ACTION_META = {
  start: { icon: 'play', label: 'Iniciar' },
  restart: { icon: 'restart', label: 'Reiniciar' },
  stop: { icon: 'stop', label: 'Parar', confirm: 'Confirmar parada' },
  kill: { icon: 'x', label: 'Encerrar processo', confirm: 'Confirmar encerramento' },
  share: { icon: 'share', label: 'Compartilhar na tailnet' },
  unshare: { icon: 'unshare', label: 'Remover da tailnet', confirm: 'Confirmar remoção' },
};

function actionButton(svc, action, full) {
  const meta = ACTION_META[action];
  const id = `${svc.key}|${action}`;
  const armed = meta.confirm && isArmed(id);
  return h(
    'button',
    {
      class: ['btn', full ? '' : 'ghost icon-btn', armed && 'armed', (action === 'stop' || action === 'kill') && !armed && full && 'danger'],
      type: 'button',
      title: full ? undefined : armed ? meta.confirm : meta.label,
      'aria-label': `${armed ? meta.confirm : meta.label}: ${svc.name}`,
      dataset: { action: 'svc-action', key: svc.key, op: action },
    },
    icon(meta.icon),
    full && (armed ? meta.confirm : meta.label),
  );
}

function rowActions(svc) {
  const link = primaryLink(svc);
  const ops = svc.actions.filter((a) => a === 'start' || a === 'restart' || a === 'stop' || a === 'kill');
  return [
    link && h('a', { class: 'btn ghost icon-btn', href: link.url, target: '_blank', rel: 'noopener', title: `Abrir ${link.url}`, 'aria-label': `Abrir ${svc.name}` }, icon('external')),
    ...ops.map((a) => actionButton(svc, a, false)),
    h('button', { class: 'btn ghost icon-btn', type: 'button', title: 'Logs e detalhes', 'aria-label': `Logs e detalhes de ${svc.name}`, dataset: { action: 'open-service', key: svc.key } }, icon('chevron', 'icon')),
  ];
}

function row(svc) {
  const first = svc.ports[0];
  const link = primaryLink(svc);
  return h(
    'div',
    { class: ['svc', svc.state !== 'running' && 'is-stopped'], dataset: { key: svc.key } },
    h('div', { class: ['svc-port', !first && 'none'] }, first ? portLabel(first.port) : '—', svc.ports.length > 1 && h('small', null, svc.ports.slice(1).map((p) => `:${p.port}`).join('  '))),
    h(
      'div',
      { class: 'svc-name' },
      h('button', { type: 'button', dataset: { action: 'open-service', key: svc.key } }, link && favicon(link.url, svc.name), h('strong', null, svc.name), svc.pinned && icon('pin', 'icon pin-mark')),
      h('div', { class: 'svc-sub', title: svc.cmd }, subtitle(svc)),
    ),
    h('div', { class: 'svc-state' }, stateMark(svc.state, svc.stateText)),
    h('div', { class: 'svc-reach' }, reachChips(svc)),
    h('div', { class: 'svc-usage' }, usage(svc)),
    h('div', { class: 'svc-actions' }, rowActions(svc)),
  );
}

// ------------------------------------------------------------ quadro

function visible(svc) {
  if (svc.hidden && !filter.hidden) return false;
  if (svc.background && !filter.bg) return false;
  if (filter.state === 'running' && svc.state !== 'running') return false;
  if (filter.state === 'stopped' && svc.state === 'running') return false;
  if (!filter.text) return true;
  const hay = fold(`${svc.name} ${svc.detectedName} ${svc.project ?? ''} ${svc.detail ?? ''} ${svc.ports.map((p) => `${p.port} :${p.port} ${p.http?.title ?? ''}`).join(' ')} ${svc.image ?? ''}`);
  return fold(filter.text)
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function renderServices() {
  const snap = store.services;
  const board = document.getElementById('board');
  if (!snap) return;
  const all = snap.services;
  document.getElementById('svc-bg-count').textContent = String(all.filter((s) => s.background).length);
  document.getElementById('svc-hidden-count').textContent = String(all.filter((s) => s.hidden).length);
  const shown = all.filter(visible);
  const running = shown.filter((s) => s.state === 'running').length;
  document.getElementById('svc-summary').textContent = `${running} rodando, ${shown.length - running} parados${snap.docker ? '' : '. Docker indisponível.'}`;

  const groups = new Map();
  for (const svc of shown) {
    const name = svc.pinned ? 'Fixados' : svc.background ? 'Apps e sistema' : (svc.project ?? 'Sem projeto');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(svc);
  }
  if (!shown.length) {
    morph(board, h('p', { class: 'empty' }, filter.text ? `Nada encontrado para "${filter.text}".` : 'Nenhum serviço com esses filtros.'));
    return;
  }
  morph(
    board,
    [...groups.entries()].map(([name, list]) => {
      const dockerCount = list.filter((s) => s.kind === 'docker').length;
      const isCompose = name !== 'Fixados' && dockerCount > 1 && list.every((s) => s.kind === 'docker');
      const anyRunning = list.some((s) => s.state === 'running');
      return h(
        'section',
        { class: 'proj', dataset: { key: `g:${name}` } },
        h(
          'div',
          { class: 'proj-head' },
          h('h2', null, name),
          h('span', { class: 'count' }, String(list.length)),
          isCompose &&
            h(
              'div',
              { class: 'section-tools' },
              anyRunning
                ? [
                    h('button', { class: 'btn ghost', type: 'button', dataset: { action: 'project-action', project: name, op: 'restart' } }, icon('restart'), 'Reiniciar todos'),
                    h('button', { class: ['btn ghost', isArmed(`p|${name}`) && 'armed'], type: 'button', dataset: { action: 'project-action', project: name, op: 'stop' } }, icon('stop'), isArmed(`p|${name}`) ? 'Confirmar parada' : 'Parar todos'),
                  ]
                : h('button', { class: 'btn ghost', type: 'button', dataset: { action: 'project-action', project: name, op: 'start' } }, icon('play'), 'Iniciar todos'),
            ),
        ),
        list.map(row),
      );
    }),
  );
}

// ------------------------------------------------------------ painel lateral

const drawerEl = () => document.getElementById('drawer');

export function openDrawer(key) {
  const svc = serviceByKey(key);
  if (!svc) return;
  ui.drawerKey = key;
  ui.drawerTab = 'logs';
  history.replaceState(null, '', `#${ui.tab}/${encodeURIComponent(key)}`);
  drawerRequests = null;
  drawerEl().hidden = false;
  document.getElementById('scrim').hidden = false;
  selectDrawerTab('logs');
  openLogs(key, svc.name);
  renderDrawer();
  refreshActive();
  drawerEl().querySelector('.close')?.focus();
}

let lastFocus = null;

export function closeDrawer() {
  closeLogs();
  ui.drawerKey = null;
  history.replaceState(null, '', `#${ui.tab}`);
  drawerEl().hidden = true;
  document.getElementById('scrim').hidden = true;
  lastFocus?.focus?.();
}

function selectDrawerTab(tab) {
  ui.drawerTab = tab;
  for (const b of document.querySelectorAll('[data-dtab]')) b.setAttribute('aria-selected', String(b.dataset.dtab === tab));
  for (const p of document.querySelectorAll('[data-dpanel]')) p.hidden = p.dataset.dpanel !== tab;
  if (tab === 'acessos') {
    refreshActive();
    const svc = serviceByKey(ui.drawerKey);
    if (svc?.accessLog && !drawerRequests) void loadDrawerRequests();
  }
  renderDrawer();
}

let drawerRequests = null;

async function loadDrawerRequests() {
  const key = ui.drawerKey;
  drawerRequests = { key, loading: true };
  renderDrawer();
  try {
    drawerRequests = { key, data: await api(`/api/services/${encodeURIComponent(key)}/requests`) };
  } catch (err) {
    drawerRequests = { key, data: { available: false, reason: err.message } };
  }
  renderDrawer();
}

function drawerHead(svc) {
  const first = svc.ports[0];
  const link = primaryLink(svc);
  const ops = svc.actions.filter((a) => a !== 'share' && a !== 'unshare');
  const killArmedForce = svc.actions.includes('kill') && forceKill.has(svc.key);
  return [
    h(
      'div',
      { class: 'drawer-title' },
      first && h('span', { class: 'svc-port' }, portLabel(first.port)),
      h('div', null, h('h2', { id: 'drawer-title' }, svc.name), h('div', { class: 'svc-sub' }, subtitle(svc))),
      h('button', { class: 'btn ghost icon-btn close', type: 'button', 'aria-label': 'Fechar painel', dataset: { action: 'close-drawer' } }, icon('x')),
    ),
    h(
      'div',
      { class: 'drawer-meta' },
      stateMark(svc.state, svc.stateText),
      svc.project && h('span', null, `projeto ${svc.project}`),
      svc.state === 'running' && svc.startedAt && h('span', null, `no ar há ${duration((Date.now() - svc.startedAt) / 1000)}`),
      svc.state === 'running' && svc.cpu !== undefined && h('span', { class: 'num' }, `CPU ${pct(svc.cpu)}`),
      svc.state === 'running' && svc.mem !== undefined && h('span', { class: 'num' }, `RAM ${bytes(svc.mem)}`),
    ),
    h(
      'div',
      { class: 'drawer-actions' },
      link && h('a', { class: 'btn primary', href: link.url, target: '_blank', rel: 'noopener' }, icon('external'), 'Abrir'),
      ops.map((a) => actionButton(svc, a, true)),
      killArmedForce && h('button', { class: 'btn danger', type: 'button', dataset: { action: 'svc-action', key: svc.key, op: 'kill', force: '1' } }, icon('zap'), 'Forçar encerramento'),
      svc.actions.includes('share') && actionButton(svc, 'share', true),
      svc.actions.includes('unshare') && actionButton(svc, 'unshare', true),
      h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': String(svc.pinned), dataset: { action: 'svc-pin', key: svc.key } }, icon('pin'), svc.pinned ? 'Fixado no início' : 'Fixar no início'),
      h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': String(svc.hidden), dataset: { action: 'svc-hide', key: svc.key } }, icon(svc.hidden ? 'eye' : 'eyeOff'), svc.hidden ? 'Mostrar na lista' : 'Ocultar da lista'),
    ),
  ];
}

function copyBtn(text) {
  return h('button', { class: 'btn ghost icon-btn', type: 'button', title: 'Copiar', 'aria-label': `Copiar ${text}`, dataset: { action: 'copy', text } }, icon('copy'));
}

function details(svc) {
  const rows = [
    ['Tipo', KIND_LABEL[svc.kind]],
    ['Nome detectado', svc.detectedName !== svc.name ? svc.detectedName : null],
    ['Projeto', svc.project],
    ['Estado', svc.stateText],
    ['Saúde', svc.health],
    ['Unit', svc.unit && h('span', { class: 'mono' }, svc.unit)],
    ['Container', svc.containerId && h('span', { class: 'mono' }, svc.containerId.slice(0, 12))],
    ['Imagem', svc.image && h('span', { class: 'mono' }, svc.image)],
    ['PID', svc.pid && h('span', { class: 'mono' }, String(svc.pid))],
    ['Diretório', svc.cwd && h('span', { class: 'mono' }, svc.cwd)],
    ['Comando', svc.cmd && h('span', { class: 'mono' }, svc.cmd)],
    [svc.state === 'running' ? 'Iniciado' : 'Parou', svc.startedAt && `${new Date(svc.startedAt).toLocaleString('pt-BR')} (${ago(svc.startedAt)})`],
  ].filter(([, v]) => v);
  return [
    h('h3', { class: 'subhead' }, 'Endereços'),
    svc.links.length
      ? h(
          'dl',
          { class: 'kv' },
          svc.links.flatMap((l) => [
            h('dt', null, h('span', { class: 'who' }, kindDot(l.kind === 'local' ? 'self' : l.kind), PEER_LABEL[l.kind === 'local' ? 'self' : l.kind])),
            h('dd', null, h('a', { class: 'mono', href: l.url, target: '_blank', rel: 'noopener' }, l.url), ' ', copyBtn(l.url), l.note && h('div', { class: 'help' }, l.note)),
          ]),
        )
      : h('p', { class: 'help' }, svc.state === 'running' ? 'Nenhuma porta HTTP acessível.' : 'O serviço não está rodando.'),
    svc.ports.length > 0 && h('h3', { class: 'subhead' }, 'Portas'),
    svc.ports.length > 0 &&
      h(
        'dl',
        { class: 'kv' },
        svc.ports.flatMap((p) => [
          h('dt', { class: 'mono' }, `:${p.port}${p.inner && p.inner !== p.port ? ` → ${p.inner}` : ''}`),
          h(
            'dd',
            null,
            `${p.protocol ?? (p.http ? (p.http.https ? 'HTTPS' : 'HTTP') : 'TCP')}${p.http ? `, respondeu ${p.http.status} em ${p.http.ms} ms` : ''}`,
            h('div', { class: 'help' }, `Escutando em ${p.hosts.join(', ')}: ${SCOPE_TEXT[p.scope]}.`),
          ),
        ]),
      ),
    h('h3', { class: 'subhead' }, 'Informações'),
    h(
      'dl',
      { class: 'kv' },
      rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    ),
    h('h3', { class: 'subhead' }, 'Ajustes'),
    h(
      'form',
      { class: 'inline-form', dataset: { form: 'rename' } },
      h('label', { class: 'sr-only', for: 'rename-input' }, 'Nome exibido'),
      h('input', { class: 'input', id: 'rename-input', name: 'displayName', placeholder: svc.detectedName, value: svc.name !== svc.detectedName ? svc.name : '' }),
      h('button', { class: 'btn', type: 'submit' }, 'Renomear'),
    ),
    h('p', { class: 'help' }, 'Deixe em branco para voltar ao nome detectado.'),
    svc.kind === 'process' &&
      h(
        'form',
        { class: 'inline-form', dataset: { form: 'logfile' } },
        h('label', { class: 'sr-only', for: 'logfile-input' }, 'Arquivo de log'),
        h('input', { class: 'input mono', id: 'logfile-input', name: 'logFile', placeholder: '/caminho/para/app.log', value: store.config?.services?.[svc.key]?.logFile ?? '' }),
        h('button', { class: 'btn', type: 'submit' }, 'Usar arquivo de log'),
      ),
    svc.kind === 'process' && h('p', { class: 'help' }, svc.logHint ?? 'Os logs são lidos do arquivo para onde o processo escreve.'),
    svc.logs &&
      h(
        'label',
        { class: 'check', style: { 'margin-top': '14px' } },
        h('input', { type: 'checkbox', checked: svc.accessLog, dataset: { action: 'svc-accesslog', key: svc.key } }),
        h('span', null, 'Ler os logs como access log (visitas na aba Acessos)'),
      ),
  ];
}

export function renderDrawer() {
  if (!ui.drawerKey) return;
  const svc = serviceByKey(ui.drawerKey);
  if (!svc) return;
  morph(document.getElementById('drawer-head'), drawerHead(svc));
  if (ui.drawerTab === 'detalhes') {
    const panel = document.getElementById('drawer-details');
    // Não redesenha enquanto o usuário digita num dos campos.
    if (!panel.contains(document.activeElement) || document.activeElement.type === 'checkbox' || !panel.childElementCount) morph(panel, details(svc));
  }
  if (ui.drawerTab === 'acessos') morph(document.getElementById('drawer-access'), renderAccessFor(svc, drawerRequests?.key === svc.key ? drawerRequests : null));
}

// ------------------------------------------------------------ ações

const forceKill = new Set();

async function runAction(key, op, extra = {}) {
  const res = await api(`/api/services/${encodeURIComponent(key)}/action`, { method: 'POST', body: { action: op, ...extra } });
  set('services', res.snapshot);
  if (op === 'kill' && res.stillAlive) forceKill.add(key);
  else forceKill.delete(key);
  if (op === 'share' && res.url) await navigator.clipboard?.writeText(res.url).catch(() => {});
  toast(op === 'share' && res.url ? `${res.message} (endereço copiado)` : res.message);
  renderDrawer();
}

async function patchService(key, body, message) {
  const snap = await api(`/api/services/${encodeURIComponent(key)}`, { method: 'PATCH', body });
  set('config', await api('/api/config'));
  set('services', snap);
  if (message) toast(message);
}

export function initServices() {
  initLogs();
  const filterInput = document.getElementById('svc-filter');
  filterInput.addEventListener('input', () => {
    filter.text = filterInput.value.trim();
    renderServices();
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterInput.value = '';
      filter.text = '';
      renderServices();
    }
  });
  document.getElementById('svc-state').addEventListener('click', (e) => {
    const b = e.target.closest('[data-state]');
    if (!b) return;
    filter.state = b.dataset.state;
    for (const x of e.currentTarget.children) x.setAttribute('aria-checked', String(x === b));
    renderServices();
  });
  document.getElementById('svc-bg').addEventListener('change', (e) => {
    filter.bg = e.target.checked;
    renderServices();
  });
  document.getElementById('svc-hidden').addEventListener('change', (e) => {
    filter.hidden = e.target.checked;
    renderServices();
  });

  onAction('open-service', (el) => {
    lastFocus = el;
    openDrawer(el.dataset.key);
  });
  onAction('close-drawer', closeDrawer);
  document.getElementById('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.drawerKey && !document.querySelector('dialog[open]')) closeDrawer();
  });
  for (const b of document.querySelectorAll('[data-dtab]')) b.addEventListener('click', () => selectDrawerTab(b.dataset.dtab));
  onAction('logs-reconnect', reconnectLogs);
  onAction('load-requests', () => loadDrawerRequests());

  onAction('svc-action', async (el) => {
    const { key, op, force } = el.dataset;
    const meta = ACTION_META[op];
    const id = `${key}|${op}`;
    if (meta.confirm && !force && !isArmed(id)) {
      arm(id, () => {
        renderServices();
        renderDrawer();
      });
      renderServices();
      renderDrawer();
      return;
    }
    disarm(id);
    el.disabled = true;
    try {
      await runAction(key, op, force ? { force: true } : {});
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      el.disabled = false;
      renderServices();
    }
  });

  onAction('project-action', async (el) => {
    const { project, op } = el.dataset;
    if (op === 'stop' && !isArmed(`p|${project}`)) {
      arm(`p|${project}`, renderServices);
      renderServices();
      return;
    }
    disarm(`p|${project}`);
    el.disabled = true;
    try {
      const res = await api(`/api/projects/${encodeURIComponent(project)}/action`, { method: 'POST', body: { action: op } });
      set('services', res.snapshot);
      toast(res.message);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      el.disabled = false;
    }
  });

  onAction('svc-pin', (el) => {
    const svc = serviceByKey(el.dataset.key);
    void patchService(svc.key, { pinned: !svc.pinned }, svc.pinned ? 'Removido do início.' : 'Fixado: aparece primeiro e avisa se parar.').catch((err) => toast(err.message, 'error'));
  });
  onAction('svc-hide', (el) => {
    const svc = serviceByKey(el.dataset.key);
    void patchService(svc.key, { hidden: !svc.hidden }, svc.hidden ? 'Visível na lista de novo.' : 'Ocultado. Marque "Ocultos" nos filtros para vê-lo.').catch((err) => toast(err.message, 'error'));
  });
  onAction('copy', async (el) => {
    await navigator.clipboard.writeText(el.dataset.text);
    toast('Copiado.');
  });

  // Checkbox do access log: o clique delegado não pode impedir a marcação.
  document.getElementById('drawer-details').addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'svc-accesslog') return;
    void patchService(e.target.dataset.key, { accessLog: e.target.checked }, 'Ajuste salvo.').then(() => refresh('requests'));
  });
  document.getElementById('drawer-details').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const key = ui.drawerKey;
    try {
      if (form.dataset.form === 'rename') await patchService(key, { name: form.elements.displayName.value }, 'Nome salvo.');
      if (form.dataset.form === 'logfile') {
        await patchService(key, { logFile: form.elements.logFile.value }, 'Arquivo de log salvo.');
        await refresh('services');
        reconnectLogs();
      }
      document.activeElement?.blur();
      renderDrawer();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
