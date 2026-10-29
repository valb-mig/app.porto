import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serverConnections, type Conn } from './connections.ts';
import { classifyIp, isTailnet, localNetworks, type PeerKind } from './net.ts';
import { procDetails, projectOf, prettyProcess } from './procs.ts';
import { containerByIp, lastServices, servicesSnapshot, type Service } from './services.ts';
import { cgroupLeaf, sockets } from './sockets.ts';
import { tailscaleState, type TsState } from './tailscale.ts';
import { STATE_DIR, errorText, writeJson } from './util.ts';

export type Peer = { kind: PeerKind; label: string; ip: string; detail?: string };
export type LiveConn = { service: string; serviceName: string; port: number; via?: string; peer: Peer; count: number };
export type HistoryEntry = {
  service: string;
  serviceName: string;
  kind: PeerKind;
  label: string;
  ip: string;
  detail?: string;
  first: number;
  last: number;
  /** Quantas amostras (a cada SAMPLE_MS) viram esse acesso ativo. */
  samples: number;
  peak: number;
};

const SAMPLE_MS = 3_000;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_ENTRIES = 3_000;
const HISTORY_PATH = join(STATE_DIR, 'access-history.json');

let live: LiveConn[] = [];
const history = new Map<string, HistoryEntry>();
let dirty = false;

const pidLabels = new Map<number, string>();

/** Nome do processo cliente; pra node/python mostra também o projeto de onde ele roda. */
async function clientLabel(pid: number, name: string) {
  const cached = pidLabels.get(pid);
  if (cached) return cached;
  let label = prettyProcess(name);
  if (/^(node|python3?|php|bun|deno|ruby|java)$/.test(label)) {
    const project = await projectOf((await procDetails(pid)).cwd);
    if (project) label = `${label} (${project.name})`;
  }
  if (pidLabels.size > 500) pidLabels.clear();
  pidLabels.set(pid, label);
  return label;
}

async function describePeer(c: Conn, ts: TsState, nets: ReturnType<typeof localNetworks>): Promise<Peer> {
  const kind = classifyIp(c.peerHost, nets);
  const ip = c.peerHost;
  if (kind === 'local' || kind === 'self') {
    if (c.client?.pid && c.client.name) return { kind, ip, label: await clientLabel(c.client.pid, c.client.name) };
    const leaf = cgroupLeaf(c.client?.cgroup);
    if (leaf) return { kind, ip, label: leaf.replace(/\.(service|scope)$/, ''), detail: 'processo de outro usuário' };
    return { kind, ip, label: 'Esta máquina' };
  }
  if (kind === 'tailnet') {
    const dev = ts.peers.find((p) => p.ips.includes(ip));
    return dev ? { kind, ip, label: dev.name, detail: dev.os } : { kind, ip, label: ip, detail: 'dispositivo fora da lista da tailnet' };
  }
  if (kind === 'docker') {
    const ct = containerByIp(ip);
    return { kind, ip, label: ct?.name ?? ip, detail: ct ? 'container' : undefined };
  }
  return { kind, ip, label: ip };
}

const SERVICES_MAX_AGE_MS = 15_000;

async function sample() {
  // Pra mapear porta → serviço basta um snapshot recente; não precisa redescobrir tudo a cada amostra.
  const recent = lastServices();
  const [snap, socks, ts] = await Promise.all([
    recent && Date.now() - recent.at < SERVICES_MAX_AGE_MS ? recent : servicesSnapshot(),
    sockets(),
    tailscaleState(),
  ]);
  const nets = localNetworks();
  const byPort = new Map<number, Service>();
  for (const svc of snap.services) for (const p of svc.ports) if (!byPort.has(p.port)) byPort.set(p.port, svc);
  const serve = new Map(ts.serve.map((s) => [s.httpsPort, s]));
  const groups = new Map<string, LiveConn>();
  for (const c of serverConnections(socks)) {
    // Perna local do proxy do Tailscale: o acesso de verdade já aparece do lado da tailnet.
    if (cgroupLeaf(c.client?.cgroup) === 'tailscaled.service') continue;
    let svc = byPort.get(c.localPort);
    let via: string | undefined;
    const s = isTailnet(c.localHost) ? serve.get(c.localPort) : undefined;
    if (s) {
      svc = s.targetPort === null ? undefined : byPort.get(s.targetPort);
      via = s.funnel ? 'Tailscale Funnel' : 'Tailscale serve';
    }
    if (!svc) continue;
    const peer = await describePeer(c, ts, nets);
    const key = `${svc.key}|${peer.kind}|${peer.label}|${via ?? ''}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { service: svc.key, serviceName: svc.name, port: s ? s.httpsPort : c.localPort, via, peer, count: 1 });
  }
  live = [...groups.values()];

  const now = Date.now();
  for (const l of live) {
    const key = `${l.service}|${l.peer.kind}|${l.peer.label}`;
    const h = history.get(key);
    if (h) {
      h.last = now;
      h.samples++;
      h.peak = Math.max(h.peak, l.count);
      h.serviceName = l.serviceName;
      h.ip = l.peer.ip;
    } else {
      history.set(key, { service: l.service, serviceName: l.serviceName, kind: l.peer.kind, label: l.peer.label, ip: l.peer.ip, detail: l.peer.detail, first: now, last: now, samples: 1, peak: l.count });
    }
    dirty = true;
  }
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const [k, h] of history) if (h.last < cutoff) history.delete(k);
  if (history.size > MAX_ENTRIES) {
    const sorted = [...history.entries()].sort((a, b) => b[1].last - a[1].last);
    for (const [k] of sorted.slice(MAX_ENTRIES)) history.delete(k);
  }
}

export async function saveAccessHistory() {
  if (!dirty) return;
  prune();
  dirty = false;
  await writeJson(HISTORY_PATH, [...history.values()]).catch((err) => console.error('[access] não salvou o histórico:', errorText(err)));
}

export async function startAccessSampler() {
  try {
    const saved = JSON.parse(await readFile(HISTORY_PATH, 'utf8')) as HistoryEntry[];
    for (const h of saved) history.set(`${h.service}|${h.kind}|${h.label}`, h);
    prune();
  } catch {
    // Primeira execução ou arquivo corrompido: começa vazio.
  }
  const tick = () => sample().catch((err) => console.error('[access]', errorText(err)));
  void tick();
  setInterval(tick, SAMPLE_MS).unref();
  setInterval(() => void saveAccessHistory(), 60_000).unref();
}

export function accessSnapshot() {
  return {
    live,
    history: [...history.values()].sort((a, b) => b.last - a.last),
    sampleMs: SAMPLE_MS,
  };
}
