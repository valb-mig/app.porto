import { lineChart } from './charts.js';
import { ago, api, favicon, fold, h, hostOf, icon, kindDot, morph, num, stateMark, toast } from './lib.js';
import { refresh } from './main.js';
import { onAction, primaryLink, set, store } from './store.js';

let editing = false;
let firstBerths = true;

// ------------------------------------------------------------ relógio

const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const d = weekday.format(now);
  document.getElementById('today').textContent = d.charAt(0).toUpperCase() + d.slice(1);
}

// ------------------------------------------------------------ busca / omnibox

let suggestions = [];
let selected = 0;

/** Transforma o texto digitado num endereço, se ele parecer um. */
function asUrl(q) {
  const t = q.trim();
  if (/^:?\d{2,5}(\/.*)?$/.test(t)) return `http://localhost:${t.replace(/^:/, '')}`;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) && !/\s/.test(t)) return `https://${t}`;
  return null;
}

function buildSuggestions(q) {
  const out = [];
  const fq = fold(q.trim());
  if (!fq) return out;
  const url = asUrl(q);
  if (url) {
    const port = /^:?(\d{2,5})/.exec(q.trim())?.[1];
    const svc = port && store.services?.services.find((s) => s.ports.some((p) => String(p.port) === port));
    out.push({ url, title: svc ? `Abrir ${svc.name}` : `Abrir ${url.replace(/^https?:\/\//, '')}`, sub: svc ? url : '', hint: 'endereço' });
  }
  for (const g of store.config?.groups ?? []) {
    for (const it of g.items) {
      if (fold(`${it.title} ${it.url}`).includes(fq)) out.push({ url: it.url, title: it.title, sub: hostOf(it.url), hint: g.title, icon: it.url });
    }
  }
  for (const svc of store.services?.services ?? []) {
    if (svc.hidden || svc.state !== 'running') continue;
    const link = primaryLink(svc);
    if (!link) continue;
    const hay = fold(`${svc.name} ${svc.project ?? ''} ${svc.ports.map((p) => p.port).join(' ')} ${svc.ports.map((p) => p.http?.title ?? '').join(' ')}`);
    if (hay.includes(fq)) out.push({ url: link.url, title: svc.name, sub: link.url, hint: svc.project ?? 'serviço', icon: link.url });
  }
  const searchUrl = store.config?.settings.searchUrl ?? 'https://duckduckgo.com/?q=%s';
  out.push({ url: searchUrl.replace('%s', encodeURIComponent(q.trim())), title: `Buscar "${q.trim()}"`, sub: hostOf(searchUrl), hint: 'web' });
  return out.slice(0, 9);
}

function renderSuggestions() {
  const list = document.getElementById('omni-list');
  const input = document.getElementById('omni-input');
  input.setAttribute('aria-expanded', String(suggestions.length > 0));
  list.hidden = suggestions.length === 0;
  morph(
    list,
    suggestions.map((sug, i) =>
      h(
        'li',
        { role: 'option', id: `omni-${i}`, 'aria-selected': String(i === selected), dataset: { key: `${i}:${sug.url}`, index: String(i) } },
        sug.icon ? favicon(sug.icon, sug.title) : icon(sug.hint === 'web' ? 'search' : 'external'),
        h('span', { class: 'sub-wrap' }, h('div', null, sug.title), sug.sub && h('div', { class: 'sub' }, sug.sub)),
        h('span', { class: 'hint' }, sug.hint),
      ),
    ),
  );
  if (suggestions.length) input.setAttribute('aria-activedescendant', `omni-${selected}`);
  else input.removeAttribute('aria-activedescendant');
}

function go(url, newTab) {
  if (newTab) window.open(url, '_blank', 'noopener');
  else location.href = url;
}

function initOmni() {
  const input = document.getElementById('omni-input');
  if (window.innerWidth < 640) input.placeholder = 'Buscar ou abrir uma porta';
  const list = document.getElementById('omni-list');
  input.addEventListener('input', () => {
    suggestions = buildSuggestions(input.value);
    selected = 0;
    renderSuggestions();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (e.key === 'Escape') {
      input.value = '';
      suggestions = [];
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sug = suggestions[selected];
      if (sug) go(sug.url, e.ctrlKey || e.metaKey);
    }
  });
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-index]');
    if (!li) return;
    e.preventDefault();
    go(suggestions[Number(li.dataset.index)].url, e.ctrlKey || e.metaKey || e.button === 1);
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      suggestions = [];
      renderSuggestions();
    }, 120),
  );
  document.getElementById('omni').addEventListener('submit', (e) => e.preventDefault());
}

// ------------------------------------------------------------ atalhos

const groups = () => store.config?.groups ?? [];

async function saveGroups(next) {
  const cfg = await api('/api/config/groups', { method: 'PUT', body: { groups: next } });
  set('config', { ...store.config, ...cfg });
  renderShortcuts();
}

function renderShortcuts() {
  const root = document.getElementById('shortcuts');
  root.classList.toggle('editing', editing);
  const list = groups();
  if (!list.length) {
    morph(root, h('p', { class: 'empty' }, 'Nenhum atalho ainda. Use "Editar atalhos" e depois "Novo grupo" para começar.'));
    return;
  }
  morph(
    root,
    list.map((g) =>
      h(
        'section',
        { class: 'group', dataset: { key: g.id, group: g.id } },
        h(
          'h3',
          null,
          g.title,
          editing && h('button', { class: 'btn ghost icon-btn edit-btn', type: 'button', title: `Renomear ou excluir ${g.title}`, 'aria-label': `Editar grupo ${g.title}`, dataset: { action: 'edit-group', group: g.id } }, icon('pencil')),
        ),
        h(
          'ul',
          { dataset: { dropGroup: g.id } },
          g.items.map((it) =>
            h(
              'li',
              { dataset: { key: it.id } },
              h(
                'a',
                { class: 'shortcut', href: it.url, draggable: editing ? 'true' : 'false', dataset: { item: it.id, group: g.id } },
                favicon(it.url, it.title),
                h('span', { class: 'title' }, it.title),
                h('span', { class: 'host' }, hostOf(it.url)),
                editing && h('button', { class: 'btn ghost icon-btn edit-btn', type: 'button', 'aria-label': `Editar ${it.title}`, dataset: { action: 'edit-shortcut', item: it.id, group: g.id } }, icon('pencil')),
              ),
            ),
          ),
          editing && !g.items.length && h('li', { class: 'empty' }, 'Arraste atalhos para cá.'),
        ),
      ),
    ),
  );
}

function openShortcutDialog(groupId, itemId) {
  const dlg = document.getElementById('dlg-shortcut');
  const form = document.getElementById('form-shortcut');
  const group = groups().find((g) => g.id === groupId);
  const item = group?.items.find((i) => i.id === itemId);
  document.getElementById('dlg-shortcut-title').textContent = item ? 'Editar atalho' : 'Novo atalho';
  form.title.value = item?.title ?? '';
  form.url.value = item?.url ?? '';
  form.group.replaceChildren(...groups().map((g) => h('option', { value: g.id, selected: g.id === groupId }, g.title)));
  form.querySelector('[data-action="delete-shortcut"]').hidden = !item;
  form.querySelector('[data-error]').hidden = true;
  form.dataset.item = itemId ?? '';
  form.dataset.group = groupId ?? '';
  dlg.showModal();
}

function initShortcuts() {
  onAction('toggle-edit', (btn) => {
    editing = !editing;
    btn.setAttribute('aria-pressed', String(editing));
    btn.textContent = editing ? 'Concluir edição' : 'Editar atalhos';
    document.getElementById('add-shortcut-btn').hidden = !editing;
    document.getElementById('add-group-btn').hidden = !editing;
    renderShortcuts();
  });
  onAction('add-shortcut', () => {
    if (!groups().length) return toast('Crie um grupo primeiro.', 'error');
    openShortcutDialog(groups()[0].id);
  });
  onAction('edit-shortcut', (btn) => openShortcutDialog(btn.dataset.group, btn.dataset.item));
  onAction('close-dialog', (btn) => btn.closest('dialog').close());

  document.getElementById('form-shortcut').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    let url = form.url.value.trim();
    if (!/^https?:\/\//i.test(url)) url = (/^(localhost|127\.|\[::1\]|:?\d+$)/.test(url) ? 'http://' : 'https://') + url.replace(/^:(\d+)/, 'localhost:$1').replace(/^(\d+)$/, 'localhost:$1');
    const entry = { id: form.dataset.item || crypto.randomUUID().slice(0, 8), title: form.title.value.trim(), url };
    const next = structuredClone(groups());
    for (const g of next) g.items = g.items.filter((i) => i.id !== entry.id);
    const target = next.find((g) => g.id === form.group.value);
    const prev = groups().find((g) => g.id === form.dataset.group)?.items.findIndex((i) => i.id === entry.id) ?? -1;
    if (prev >= 0 && form.group.value === form.dataset.group) target.items.splice(prev, 0, entry);
    else target.items.push(entry);
    try {
      await saveGroups(next);
      form.closest('dialog').close();
      toast(form.dataset.item ? 'Atalho salvo.' : 'Atalho criado.');
    } catch (err) {
      const p = form.querySelector('[data-error]');
      p.textContent = err.message;
      p.hidden = false;
    }
  });
  onAction('delete-shortcut', async (btn) => {
    const form = btn.closest('form');
    const next = structuredClone(groups());
    for (const g of next) g.items = g.items.filter((i) => i.id !== form.dataset.item);
    await saveGroups(next);
    form.closest('dialog').close();
    toast('Atalho excluído.');
  });

  // Grupos
  const openGroup = (id) => {
    const form = document.getElementById('form-group');
    const g = groups().find((x) => x.id === id);
    document.getElementById('dlg-group-title').textContent = g ? 'Editar grupo' : 'Novo grupo';
    form.title.value = g?.title ?? '';
    form.dataset.group = id ?? '';
    form.querySelector('[data-action="delete-group"]').hidden = !g;
    document.getElementById('dlg-group').showModal();
  };
  onAction('add-group', () => openGroup());
  onAction('edit-group', (btn) => openGroup(btn.dataset.group));
  document.getElementById('form-group').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const next = structuredClone(groups());
    const g = next.find((x) => x.id === form.dataset.group);
    if (g) g.title = form.title.value.trim();
    else next.push({ id: crypto.randomUUID().slice(0, 8), title: form.title.value.trim(), items: [] });
    await saveGroups(next);
    form.closest('dialog').close();
    toast(g ? 'Grupo salvo.' : 'Grupo criado.');
  });
  onAction('delete-group', async (btn) => {
    const form = btn.closest('form');
    const g = groups().find((x) => x.id === form.dataset.group);
    if (g?.items.length && !confirm(`Excluir o grupo "${g.title}" e os ${g.items.length} atalhos dele?`)) return;
    await saveGroups(groups().filter((x) => x.id !== form.dataset.group));
    form.closest('dialog').close();
    toast('Grupo excluído.');
  });

  // Arrastar e soltar entre grupos (só no modo de edição).
  const root = document.getElementById('shortcuts');
  let dragId = null;
  root.addEventListener('click', (e) => {
    if (editing && e.target.closest('a.shortcut') && !e.target.closest('[data-action]')) e.preventDefault();
  });
  root.addEventListener('dragstart', (e) => {
    const a = e.target.closest('a.shortcut');
    if (!editing || !a) return;
    dragId = a.dataset.item;
    a.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragend', (e) => {
    e.target.closest('a.shortcut')?.classList.remove('dragging');
    root.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    dragId = null;
  });
  root.addEventListener('dragover', (e) => {
    const ul = e.target.closest('[data-drop-group]');
    if (!dragId || !ul) return;
    e.preventDefault();
    root.querySelectorAll('.drop-target').forEach((el) => el !== ul && el.classList.remove('drop-target'));
    ul.classList.add('drop-target');
  });
  root.addEventListener('drop', async (e) => {
    const ul = e.target.closest('[data-drop-group]');
    if (!dragId || !ul) return;
    e.preventDefault();
    const next = structuredClone(groups());
    let moved;
    for (const g of next) {
      const i = g.items.findIndex((x) => x.id === dragId);
      if (i >= 0) moved = g.items.splice(i, 1)[0];
    }
    const target = next.find((g) => g.id === ul.dataset.dropGroup);
    const beforeLi = e.target.closest('li[data-key]');
    const idx = beforeLi ? target.items.findIndex((x) => x.id === beforeLi.dataset.key) : -1;
    if (idx >= 0) target.items.splice(idx, 0, moved);
    else target.items.push(moved);
    await saveGroups(next);
  });
}

// ------------------------------------------------------------ rodando agora

const REACH_LABEL = { tailnet: 'tailnet', lan: 'rede local', public: 'internet' };

function renderBerths() {
  const root = document.getElementById('berths');
  const snap = store.services;
  if (!snap) return;
  // O próprio Porto fica de fora: você já está nele.
  const self = Number(location.port || 80);
  const list = snap.services.filter((s) => s.state === 'running' && !s.hidden && !s.background && primaryLink(s) && s.ports.some((p) => p.http) && !s.ports.some((p) => p.port === self));
  const stoppedPinned = snap.services.filter((s) => s.pinned && s.state !== 'running' && !s.hidden);
  if (!list.length && !stoppedPinned.length) {
    morph(root, h('p', { class: 'empty' }, 'Nenhum servidor web rodando. Quando você subir um projeto, ele aparece aqui sozinho.'));
    return;
  }
  root.classList.toggle('first-paint', firstBerths);
  firstBerths = false;
  morph(
    root,
    [...list, ...stoppedPinned].map((svc, i) => {
      const link = primaryLink(svc);
      const port = svc.ports.find((p) => p.http) ?? svc.ports[0];
      const title = port?.http?.title;
      const reach = svc.exposure !== 'local' ? svc.exposure : null;
      return h(
        link ? 'a' : 'div',
        { class: 'berth', href: link?.url, dataset: { key: svc.key }, style: { '--i': String(i) }, title: link?.url },
        h('span', { class: 'berth-port' }, port ? [h('span', { class: 'colon' }, ':'), String(port.port)] : '—'),
        h(
          'span',
          { class: 'berth-body' },
          h('span', { class: 'berth-name' }, link && favicon(link.url, svc.name), h('strong', null, svc.name), svc.pinned && icon('pin', 'icon pin-mark')),
          h('span', { class: 'berth-sub' }, svc.state !== 'running' ? svc.stateText : title && title !== svc.name ? title : (svc.project ?? svc.detail ?? '')),
        ),
        h('span', { class: 'berth-meta' }, svc.state !== 'running' ? stateMark(svc.state, 'parado') : reach && h('span', { class: 'chip' }, kindDot(reach), REACH_LABEL[reach])),
      );
    }),
  );
}

// ------------------------------------------------------------ sites monitorados

const LEVEL = {
  up: ['running', 'no ar'],
  warn: ['starting', 'com erro'],
  down: ['failed', 'fora do ar'],
  pending: ['stopped', 'verificando'],
};

function renderSites() {
  const root = document.getElementById('sites');
  const sites = store.sites;
  if (!sites) return;
  if (!sites.length) {
    morph(root, h('p', { class: 'empty' }, 'Nenhum site monitorado. Adicione seus sites publicados para saber quando algum cair.'));
    return;
  }
  morph(
    root,
    sites.map((site) => {
      const [st, label] = LEVEL[site.level];
      const last = site.last;
      return h(
        'div',
        { class: 'site', dataset: { key: site.id } },
        h('div', { class: 'site-title' }, favicon(site.url, site.title), h('a', { href: site.url, title: site.url }, site.title)),
        h('div', { class: 'spark', dataset: { spark: site.id }, 'data-skip-morph': '' }),
        h(
          'div',
          { class: 'site-actions' },
          h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': `Verificar ${site.title} agora`, title: 'Verificar agora', dataset: { action: 'check-site', id: site.id } }, icon('restart')),
          h('button', { class: 'btn ghost icon-btn', type: 'button', 'aria-label': `Editar ${site.title}`, title: 'Editar', dataset: { action: 'edit-site', id: site.id } }, icon('pencil')),
        ),
        h(
          'div',
          { class: 'site-sub' },
          stateMark(st, label),
          last?.status ? h('span', { class: 'num' }, `HTTP ${last.status}`) : last?.error && h('span', null, last.error),
          last?.ms !== undefined && h('span', { class: 'num' }, `${num(last.ms)} ms`),
          site.uptime24 !== null && h('span', { class: 'num' }, `${(site.uptime24 * 100).toFixed(site.uptime24 === 1 ? 0 : 1).replace('.', ',')}% no ar em 24 h`),
          site.cert && site.cert.days <= 21 && h('span', { class: site.cert.days <= 7 ? 'warn-text' : '' }, `certificado vence em ${site.cert.days} dias`),
          site.since && site.level === 'down' && h('span', null, `desde ${ago(site.since)}`),
        ),
      );
    }),
  );
  for (const site of sites) {
    const host = root.querySelector(`[data-spark="${CSS.escape(site.id)}"]`);
    const pts = site.history.filter((r) => r.ms !== undefined).map((r) => ({ t: r.t, v: r.ms }));
    if (host) lineChart(host, pts, { format: (v) => `${num(v)} ms`, label: `Tempo de resposta de ${site.title}` });
  }
}

function openSiteDialog(id) {
  const site = store.config?.sites.find((s) => s.id === id);
  const form = document.getElementById('form-site');
  document.getElementById('dlg-site-title').textContent = site ? 'Editar site' : 'Monitorar site';
  form.title.value = site?.title ?? '';
  form.url.value = site?.url ?? '';
  form.intervalSec.value = String(site?.intervalSec ?? 120);
  form.notify.checked = site?.notify ?? true;
  form.dataset.id = id ?? '';
  form.querySelector('[data-action="delete-site"]').hidden = !site;
  form.querySelector('[data-error]').hidden = true;
  document.getElementById('dlg-site').showModal();
}

async function saveSites(next) {
  const cfg = await api('/api/config/sites', { method: 'PUT', body: { sites: next } });
  set('config', { ...store.config, ...cfg });
  await refresh('sites');
}

function initSites() {
  onAction('add-site', () => openSiteDialog());
  onAction('edit-site', (btn) => openSiteDialog(btn.dataset.id));
  onAction('check-site', async (btn) => {
    btn.disabled = true;
    try {
      set('sites', await api(`/api/sites/${encodeURIComponent(btn.dataset.id)}/check`, { method: 'POST' }));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('form-site').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    let url = form.url.value.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const entry = { id: form.dataset.id || crypto.randomUUID().slice(0, 8), title: form.title.value.trim(), url, intervalSec: Number(form.intervalSec.value), notify: form.notify.checked };
    const list = store.config?.sites ?? [];
    const next = list.some((s) => s.id === entry.id) ? list.map((s) => (s.id === entry.id ? entry : s)) : [...list, entry];
    try {
      await saveSites(next);
      form.closest('dialog').close();
      toast(form.dataset.id ? 'Site salvo.' : 'Site adicionado ao monitoramento.');
    } catch (err) {
      const p = form.querySelector('[data-error]');
      p.textContent = err.message;
      p.hidden = false;
    }
  });
  onAction('delete-site', async (btn) => {
    const form = btn.closest('form');
    await saveSites((store.config?.sites ?? []).filter((s) => s.id !== form.dataset.id));
    form.closest('dialog').close();
    toast('Site removido do monitoramento.');
  });
}

// ------------------------------------------------------------ entrada

export function initHome() {
  tickClock();
  setInterval(tickClock, 1000);
  initOmni();
  initShortcuts();
  initSites();
}

export function renderHome() {
  renderShortcuts();
  renderBerths();
  renderSites();
}
