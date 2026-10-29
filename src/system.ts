import { readFile, readdir, statfs } from 'node:fs/promises';
import { cpus, hostname, release } from 'node:os';
import { procDetails, processTable, projectOf } from './procs.ts';
import { errorText } from './util.ts';

const SAMPLE_MS = 2_000;
const HISTORY = 300;

export type SysPoint = { t: number; cpu: number; mem: number; rx: number; tx: number; temp?: number };
type Disk = { mount: string; device: string; size: number; used: number };
type Iface = { name: string; rx: number; tx: number; rxTotal: number; txTotal: number };

const history: SysPoint[] = [];
let now: {
  cpu: { pct: number; load: number[]; cores: number; model: string };
  mem: { total: number; used: number; swapTotal: number; swapUsed: number };
  net: Iface[];
  temps: { label: string; c: number }[];
  battery?: { pct: number; status: string; plugged: boolean };
  uptime: number;
} | null = null;
let disks: Disk[] = [];

let prevCpu: { idle: number; total: number } | null = null;
let prevNet: { at: number; ifaces: Map<string, { rx: number; tx: number }> } | null = null;

const read = (p: string) => readFile(p, 'utf8').then((s) => s.trim(), () => '');

async function readCpu() {
  const line = (await read('/proc/stat')).split('\n', 1)[0]!;
  const n = line.split(/\s+/).slice(1, 9).map(Number);
  const cur = { idle: n[3]! + n[4]!, total: n.reduce((a, b) => a + b, 0) };
  const pct = prevCpu && cur.total > prevCpu.total ? (1 - (cur.idle - prevCpu.idle) / (cur.total - prevCpu.total)) * 100 : 0;
  prevCpu = cur;
  return pct;
}

async function readMem() {
  const text = await read('/proc/meminfo');
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0) * 1024;
  const total = kb('MemTotal');
  return { total, used: total - kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree') };
}

/** Só interfaces físicas e a da Tailscale; veth/bridges do Docker contariam o mesmo tráfego duas vezes. */
const COUNTED_IFACE = /^(wl|en|eth|ww|tailscale)/;

async function readNet(): Promise<Iface[]> {
  const at = Date.now();
  const ifaces = new Map<string, { rx: number; tx: number }>();
  for (const line of (await read('/proc/net/dev')).split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || !COUNTED_IFACE.test(name!.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    ifaces.set(name!.trim(), { rx: f[0]!, tx: f[8]! });
  }
  const dt = prevNet ? (at - prevNet.at) / 1000 : 0;
  const out = [...ifaces.entries()].map(([name, v]) => {
    const p = prevNet?.ifaces.get(name);
    return {
      name,
      rx: p && dt > 0 ? Math.max(0, (v.rx - p.rx) / dt) : 0,
      tx: p && dt > 0 ? Math.max(0, (v.tx - p.tx) / dt) : 0,
      rxTotal: v.rx,
      txTotal: v.tx,
    };
  });
  prevNet = { at, ifaces };
  return out;
}

async function readTemps() {
  const temps: { label: string; c: number }[] = [];
  const names: Record<string, string> = { coretemp: 'Processador', k10temp: 'Processador', nvme: 'SSD', acpitz: 'Placa', iwlwifi_1: 'Wi-Fi', amdgpu: 'GPU' };
  for (const dir of await readdir('/sys/class/hwmon').catch(() => [] as string[])) {
    const base = `/sys/class/hwmon/${dir}`;
    const name = await read(`${base}/name`);
    if (!(name in names)) continue;
    // temp1 costuma ser o sensor principal (Package id 0 no coretemp, Composite no NVMe).
    const c = Number(await read(`${base}/temp1_input`)) / 1000;
    if (c > 0) temps.push({ label: names[name]!, c });
  }
  return temps;
}

async function readBattery() {
  const supplies = await readdir('/sys/class/power_supply').catch(() => [] as string[]);
  const bat = supplies.find((s) => s.startsWith('BAT'));
  if (!bat) return undefined;
  const ac = supplies.find((s) => s.startsWith('AC') || s.startsWith('ADP'));
  return {
    pct: Number(await read(`/sys/class/power_supply/${bat}/capacity`)),
    status: await read(`/sys/class/power_supply/${bat}/status`),
    plugged: ac ? (await read(`/sys/class/power_supply/${ac}/online`)) === '1' : false,
  };
}

async function readDisks() {
  const seen = new Set<string>();
  const out: Disk[] = [];
  for (const line of (await read('/proc/mounts')).split('\n')) {
    const [device, mount, fs] = line.split(' ');
    if (!device?.startsWith('/dev/') || seen.has(device) || /squashfs|iso9660/.test(fs ?? '')) continue;
    seen.add(device);
    try {
      const s = await statfs(mount!.replace(/\\040/g, ' '));
      out.push({ mount: mount!, device, size: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize });
    } catch {
      // Ponto de montagem sem permissão de leitura.
    }
  }
  disks = out;
}

async function sample() {
  const [cpu, mem, net, temps, battery, loadText, uptimeText] = await Promise.all([
    readCpu(),
    readMem(),
    readNet(),
    readTemps(),
    readBattery(),
    read('/proc/loadavg'),
    read('/proc/uptime'),
  ]);
  const info = cpus();
  now = {
    cpu: { pct: cpu, load: loadText.split(' ').slice(0, 3).map(Number), cores: info.length, model: info[0]?.model ?? '' },
    mem,
    net,
    temps,
    battery,
    uptime: Number(uptimeText.split(' ')[0]),
  };
  history.push({
    t: Date.now(),
    cpu,
    mem: (mem.used / mem.total) * 100,
    rx: net.reduce((a, i) => a + (i.name.startsWith('tailscale') ? 0 : i.rx), 0),
    tx: net.reduce((a, i) => a + (i.name.startsWith('tailscale') ? 0 : i.tx), 0),
    temp: temps.find((t) => t.label === 'Processador')?.c,
  });
  if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
}

export function startSystemSampler() {
  const tick = () => sample().catch((err) => console.error('[system]', errorText(err)));
  void tick();
  void readDisks();
  setInterval(tick, SAMPLE_MS).unref();
  setInterval(() => void readDisks(), 30_000).unref();
}

export function systemSnapshot() {
  return { host: { name: hostname(), kernel: release() }, now, disks, history, sampleMs: SAMPLE_MS };
}

const MY_UID = process.getuid?.() ?? -1;
const procPrev = new Map<number, { usec: number; at: number }>();

/** Processos que mais usam CPU e memória. O % de CPU compara com a chamada anterior. */
export async function topProcesses() {
  const table = await processTable(true);
  const at = Date.now();
  const rows = [...table.values()].map((p) => {
    const prev = procPrev.get(p.pid);
    const cpu = prev && at > prev.at ? ((p.cpuUsec - prev.usec) / ((at - prev.at) * 1000)) * 100 : 0;
    return { ...p, cpu: Math.max(0, cpu) };
  });
  procPrev.clear();
  for (const p of table.values()) procPrev.set(p.pid, { usec: p.cpuUsec, at });
  const pick = async (list: typeof rows) =>
    Promise.all(
      list.slice(0, 10).map(async (p) => {
        const d = p.uid === MY_UID ? await procDetails(p.pid) : null;
        return {
          pid: p.pid,
          name: p.comm,
          cpu: p.cpu,
          rss: p.rss,
          start: p.start,
          own: p.uid === MY_UID,
          user: p.uid === 0 ? 'root' : p.uid === MY_UID ? 'você' : String(p.uid),
          cmd: d?.cmdline.join(' ').slice(0, 300),
          project: (await projectOf(d?.cwd))?.name,
        };
      }),
    );
  return {
    byCpu: await pick([...rows].sort((a, b) => b.cpu - a.cpu)),
    byMem: await pick([...rows].sort((a, b) => b.rss - a.rss)),
    total: table.size,
  };
}
