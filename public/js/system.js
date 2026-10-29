import { lineChart, meter } from './charts.js';
import { api, arm, bytes, disarm, duration, h, icon, isArmed, morph, num1, pct, rate, toast } from './lib.js';
import { refresh } from './main.js';
import { onAction, store } from './store.js';

let procSort = 'cpu';

const BATTERY = { Charging: 'carregando', Discharging: 'na bateria', Full: 'carregada', 'Not charging': 'na tomada, sem carregar' };

function tile(label, value, sub, extra) {
  return h('div', { class: 'tile', dataset: { key: label } }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub && h('div', { class: 'sub' }, sub), extra);
}

const spark = (id) => h('div', { class: 'spark', dataset: { spark: id }, 'data-skip-morph': '' });

function renderTiles(sys) {
  const n = sys.now;
  const cpuTemp = n.temps.find((t) => t.label === 'Processador');
  const rx = n.net.filter((i) => !i.name.startsWith('tailscale')).reduce((a, i) => a + i.rx, 0);
  const tx = n.net.filter((i) => !i.name.startsWith('tailscale')).reduce((a, i) => a + i.tx, 0);
  morph(
    document.getElementById('sys-tiles'),
    tile('CPU', pct(n.cpu.pct), `${n.cpu.cores} núcleos, carga ${num1(n.cpu.load[0])}`, spark('cpu')),
    tile('Memória', bytes(n.mem.used), `de ${bytes(n.mem.total)}${n.mem.swapUsed > 0 ? `, swap ${bytes(n.mem.swapUsed)}` : ''}`, meter(n.mem.used / n.mem.total, 'Memória em uso')),
    tile('Download', rate(rx), `upload ${rate(tx)}`, spark('rx')),
    cpuTemp &&
      tile(
        'Temperatura',
        `${Math.round(cpuTemp.c)}°C`,
        n.temps
          .filter((t) => t !== cpuTemp)
          .map((t) => `${t.label} ${Math.round(t.c)}°C`)
          .join(', '),
        spark('temp'),
      ),
    n.battery && tile('Bateria', `${n.battery.pct}%`, BATTERY[n.battery.status] ?? n.battery.status, meter(n.battery.pct / 100, 'Carga da bateria', { lowIsBad: true })),
    tile('Ligado há', duration(n.uptime), `${sys.host.name}, kernel ${sys.host.kernel}`),
  );
  const hist = sys.history;
  const series = (k) => hist.slice(-60).map((p) => ({ t: p.t, v: p[k] ?? 0 }));
  const host = (id) => document.querySelector(`#sys-tiles [data-spark="${id}"]`);
  if (host('cpu')) lineChart(host('cpu'), series('cpu'), { max: 100, format: pct, label: 'CPU no último minuto' });
  if (host('rx')) lineChart(host('rx'), series('rx'), { format: rate, label: 'Download no último minuto' });
  if (host('temp')) lineChart(host('temp'), series('temp'), { format: (v) => `${Math.round(v)}°C`, label: 'Temperatura do processador' });
}

function renderCharts(sys) {
  const pts = (k) => sys.history.map((p) => ({ t: p.t, v: p[k] }));
  lineChart(document.querySelector('[data-chart="cpu"]'), pts('cpu'), { max: 100, axis: true, format: pct, label: 'Uso de CPU nos últimos 10 minutos' });
  lineChart(document.querySelector('[data-chart="mem"]'), pts('mem'), { max: 100, axis: true, format: pct, label: 'Memória em uso nos últimos 10 minutos' });
}

function renderDisks(sys) {
  morph(
    document.getElementById('disks'),
    sys.disks.map((d) =>
      h(
        'div',
        { class: 'meter-row', dataset: { key: d.device } },
        h('span', null, h('span', { class: 'mono' }, d.mount), h('span', { class: 'muted' }, `  ${d.device}`)),
        h('span', { class: 'muted num' }, `${bytes(d.used)} de ${bytes(d.size)}`),
        meter(d.used / d.size, `Ocupação de ${d.mount}`),
      ),
    ),
  );
}

function renderIfaces(sys) {
  morph(
    document.getElementById('ifaces'),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, 'Interface'), h('th', { class: 'num' }, 'Download'), h('th', { class: 'num' }, 'Upload'), h('th', { class: 'num' }, 'Recebido'), h('th', { class: 'num' }, 'Enviado'))),
      h(
        'tbody',
        null,
        sys.now.net.map((i) =>
          h(
            'tr',
            { dataset: { key: i.name } },
            h('td', { class: 'mono' }, i.name),
            h('td', { class: 'num' }, rate(i.rx)),
            h('td', { class: 'num' }, rate(i.tx)),
            h('td', { class: 'num' }, bytes(i.rxTotal)),
            h('td', { class: 'num' }, bytes(i.txTotal)),
          ),
        ),
      ),
    ),
  );
}

function renderProcs(sys) {
  if (!sys.top) return;
  document.getElementById('proc-note').textContent = `${sys.top.total} processos`;
  const list = procSort === 'cpu' ? sys.top.byCpu : sys.top.byMem;
  morph(
    document.getElementById('procs'),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, 'Processo'), h('th', null, 'Usuário'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Memória'), h('th', { class: 'r' }, h('span', { class: 'sr-only' }, 'Ações')))),
      h(
        'tbody',
        null,
        list.map((p) => {
          const id = `pid|${p.pid}`;
          return h(
            'tr',
            { dataset: { key: String(p.pid) } },
            h('td', null, h('div', null, h('strong', null, p.name), p.project && h('span', { class: 'muted' }, `  ${p.project}`), h('span', { class: 'muted num' }, `  PID ${p.pid}`)), p.cmd && h('span', { class: 'cmd', title: p.cmd }, p.cmd)),
            h('td', { class: 'muted' }, p.user),
            h('td', { class: 'num' }, pct(p.cpu)),
            h('td', { class: 'num' }, bytes(p.rss)),
            h(
              'td',
              { class: 'r' },
              p.own &&
                h(
                  'button',
                  { class: ['btn', isArmed(id) ? 'armed' : 'ghost'], type: 'button', title: 'Encerrar processo (SIGTERM)', dataset: { action: 'proc-kill', pid: String(p.pid) } },
                  icon('x'),
                  isArmed(id) ? 'Confirmar' : h('span', { class: 'sr-only' }, `Encerrar ${p.name}`),
                ),
            ),
          );
        }),
      ),
    ),
  );
}

export function renderSystem() {
  const sys = store.system;
  if (!sys?.now) return;
  renderTiles(sys);
  renderCharts(sys);
  renderDisks(sys);
  renderIfaces(sys);
  renderProcs(sys);
}

export function initSystem() {
  document.getElementById('proc-sort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    procSort = b.dataset.sort;
    for (const x of e.currentTarget.children) x.setAttribute('aria-checked', String(x === b));
    renderSystem();
  });
  onAction('proc-kill', async (el) => {
    const id = `pid|${el.dataset.pid}`;
    if (!isArmed(id)) {
      arm(id, renderSystem);
      renderSystem();
      return;
    }
    disarm(id);
    try {
      const res = await api(`/api/processes/${el.dataset.pid}/signal`, { method: 'POST' });
      toast(res.message, res.stillAlive ? 'error' : 'ok');
      await refresh('system');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
