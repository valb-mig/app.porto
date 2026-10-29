import { renderAccess } from './access.js';
import { initHome, renderHome } from './home.js';
import { api, bytes, h, kindDot, morph, pct } from './lib.js';
import { initServices, openDrawer, renderDrawer, renderServices } from './services.js';
import { serviceByKey, set, store, subscribe, ui } from './store.js';
import { initSystem, renderSystem } from './system.js';

const TABS = ['inicio', 'servicos', 'acessos', 'sistema'];

// ------------------------------------------------------------ dados (polling por necessidade)

const feeds = {
  services: { ms: 3000, path: () => '/api/services', active: () => ui.tab === 'inicio' || ui.tab === 'servicos' || Boolean(ui.drawerKey) },
  system: { ms: 2000, path: () => (ui.tab === 'sistema' ? '/api/system?top=1' : '/api/system'), active: () => true },
  sites: { ms: 15000, path: () => '/api/sites', active: () => ui.tab === 'inicio' },
  access: { ms: 3000, path: () => '/api/access', active: () => ui.tab === 'acessos' || (Boolean(ui.drawerKey) && ui.drawerTab === 'acessos') },
  requests: { ms: 15000, path: () => '/api/requests', active: () => ui.tab === 'acessos' },
};

let offline = false;

async function pull(name) {
  const feed = feeds[name];
  try {
    const data = await api(feed.path());
    feed.at = Date.now();
    if (offline) {
      offline = false;
      renderVitals();
    }
    set(name, data);
  } catch {
    if (!offline) {
      offline = true;
      renderVitals();
    }
  }
}

function loop(name) {
  const feed = feeds[name];
  const tick = async () => {
    if (!document.hidden && feed.active()) await pull(name);
    feed.timer = setTimeout(tick, feed.ms);
  };
  void tick();
}

/** Atualiza já os feeds que ficaram ativos (troca de aba, painel aberto). */
export function refreshActive() {
  for (const [name, feed] of Object.entries(feeds)) {
    if (feed.active() && Date.now() - (feed.at ?? 0) > 800) void pull(name);
  }
}

export const refresh = (name) => pull(name);

document.addEventListener('visibilitychange', () => !document.hidden && refreshActive());

// ------------------------------------------------------------ abas

/** Serviço a abrir no painel assim que a lista chegar (link direto #servicos/<chave>). */
let pendingDrawer = null;

function showTab(hash) {
  let [tab, key] = hash.split('/');
  if (key) pendingDrawer = decodeURIComponent(key);
  if (!TABS.includes(tab)) tab = 'inicio';
  ui.tab = tab;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = { inicio: 'Porto', servicos: 'Serviços · Porto', acessos: 'Acessos · Porto', sistema: 'Sistema · Porto' }[tab];
  refreshActive();
  renderAll();
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------ barra superior

function renderVitals() {
  const el = document.getElementById('vitals');
  const sys = store.system;
  document.getElementById('host-name').textContent = sys?.host.name ?? '';
  if (offline) {
    morph(el, h('span', { class: 'alert-pill' }, kindDot('internet'), 'Servidor do Porto fora do ar'));
    return;
  }
  const now = sys?.now;
  const publicCount = store.services?.services.filter((s) => s.exposure === 'public' && s.state === 'running').length ?? 0;
  morph(
    el,
    publicCount
      ? h('a', { class: 'alert-pill', href: '#servicos', title: 'Serviços acessíveis por qualquer pessoa na internet' }, kindDot('public'), `${publicCount} na internet`)
      : null,
    now && h('span', { class: 'vital' }, 'CPU ', h('b', { class: 'num' }, pct(now.cpu.pct))),
    now && h('span', { class: 'vital' }, 'RAM ', h('b', { class: 'num' }, bytes(now.mem.used))),
    now?.temps.find((t) => t.label === 'Processador') && h('span', { class: 'vital optional' }, h('b', { class: 'num' }, `${Math.round(now.temps.find((t) => t.label === 'Processador').c)}°C`)),
    now?.battery && h('span', { class: 'vital optional' }, 'Bateria ', h('b', { class: 'num' }, `${now.battery.pct}%`), now.battery.plugged ? ' na tomada' : ''),
  );
}

function renderAll() {
  if (ui.tab === 'inicio') renderHome();
  if (ui.tab === 'servicos') renderServices();
  if (ui.tab === 'acessos') renderAccess();
  if (ui.tab === 'sistema') renderSystem();
  if (ui.drawerKey) renderDrawer();
}

subscribe((key) => {
  if (key === 'system' || key === 'services') renderVitals();
  if (key === 'services' && pendingDrawer) {
    if (serviceByKey(pendingDrawer)) openDrawer(pendingDrawer);
    pendingDrawer = null;
  }
  if (key === 'system' && ui.tab !== 'sistema') return;
  renderAll();
});

// ------------------------------------------------------------ teclado

const typing = () => {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing() || document.querySelector('dialog[open]')) return;
  if (e.key === '/') {
    e.preventDefault();
    const target = ui.tab === 'servicos' ? 'svc-filter' : 'omni-input';
    if (ui.tab !== 'inicio' && ui.tab !== 'servicos') location.hash = '#inicio';
    document.getElementById(target)?.focus();
    return;
  }
  if (!ui.drawerKey && /^[1-4]$/.test(e.key)) {
    location.hash = `#${TABS[Number(e.key) - 1]}`;
    return;
  }
  // Na página inicial, começar a digitar já vai pra busca.
  if (ui.tab === 'inicio' && e.key.length === 1 && !ui.drawerKey) document.getElementById('omni-input').focus();
});

// ------------------------------------------------------------ início

async function boot() {
  set('config', await api('/api/config').catch(() => null));
  initHome();
  initServices();
  initSystem();
  showTab(location.hash.slice(1) || 'inicio');
  for (const name of Object.keys(feeds)) loop(name);
}

void boot();
