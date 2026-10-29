import { readFile } from 'node:fs/promises';
import { config } from './config.ts';
import { serverConnections } from './connections.ts';
import { listContainers, recentLogs, type Container } from './docker.ts';
import { isLoopback, isTailnet, isWildcard, localNetworks } from './net.ts';
import { KNOWN_PROTOCOLS, probe, type HttpInfo } from './probe.ts';
import { descendants, frameworkOf, procDetails, processTable, projectOf, prettyProcess, type ProcDetails } from './procs.ts';
import { cgroupLeaf, listening, sockets, type Sock } from './sockets.ts';
import { ownUnitNames, showUnits, type Unit } from './systemd.ts';
import { tailscaleState, type TsServe } from './tailscale.ts';
import { cached, mapLimit, notify } from './util.ts';

export type Scope = 'local' | 'tailnet' | 'lan' | 'all';
export type ServicePort = { port: number; hosts: string[]; scope: Scope; protocol?: string; http?: HttpInfo | null; inner?: number };
export type LinkKind = 'local' | 'lan' | 'tailnet' | 'public';
export type Link = { kind: LinkKind; url: string; note?: string; servePort?: number; servePath?: string };
export type Kind = 'docker' | 'unit' | 'process' | 'system' | 'serve';
export type Action = 'start' | 'stop' | 'restart' | 'kill' | 'share' | 'unshare';
export type State = 'running' | 'stopped' | 'starting' | 'failed';

export type Service = {
  key: string;
  kind: Kind;
  name: string;
  /** Nome detectado, antes de qualquer renomeação feita pelo usuário. */
  detectedName: string;
  project?: string;
  detail?: string;
  state: State;
  stateText: string;
  health?: string;
  ports: ServicePort[];
  links: Link[];
  exposure: 'local' | 'tailnet' | 'lan' | 'public';
  pid?: number;
  unit?: string;
  containerId?: string;
  image?: string;
  cwd?: string;
  cmd?: string;
  startedAt?: number;
  cpu?: number;
  mem?: number;
  connections: number;
  actions: Action[];
  logs: boolean;
  logHint?: string;
  accessLog: boolean;
  pinned: boolean;
  hidden: boolean;
  /** Apps do desktop e serviços do sistema: ficam recolhidos por padrão. */
  background: boolean;
};

export type Snapshot = {
  at: number;
  services: Service[];
  docker: boolean;
  tailscale: { running: boolean; dnsName?: string; ip?: string };
  lanIp?: string;
};

/** O que o backend precisa pra agir sobre um serviço, mas que não vai pro front. */
export type Handle = { container?: Container; unit?: Unit; pid?: number; logFile?: string; serve?: TsServe; cgroup?: string };

const MY_UID = process.getuid?.() ?? -1;
const ACCESS_LOG_IMAGE = /nginx|httpd|apache|caddy|traefik|openresty/i;
const SKIP_CGROUP = /\/(docker|tailscaled|containerd)\.service$/;

const scopeOf = (hosts: string[]): Scope => {
  if (hosts.some(isWildcard)) return 'all';
  if (hosts.every(isLoopback)) return 'local';
  if (hosts.every(isTailnet)) return 'tailnet';
  return 'lan';
};

function groupPorts(listens: Sock[]): ServicePort[] {
  const byPort = new Map<number, string[]>();
  for (const l of listens) {
    const list = byPort.get(l.local.port!) ?? [];
    if (!list.includes(l.local.host)) list.push(l.local.host);
    byPort.set(l.local.port!, list);
  }
  return [...byPort.entries()].sort((a, b) => a[0] - b[0]).map(([port, hosts]) => ({ port, hosts, scope: scopeOf(hosts), protocol: KNOWN_PROTOCOLS[port] }));
}

async function cgroupUsage(path: string) {
  const base = `/sys/fs/cgroup${path}`;
  try {
    const [cpu, mem] = await Promise.all([readFile(`${base}/cpu.stat`, 'utf8'), readFile(`${base}/memory.current`, 'utf8')]);
    return { usec: Number(/^usage_usec (\d+)/m.exec(cpu)?.[1] ?? 0), mem: Number(mem.trim()) };
  } catch {
    return null;
  }
}

const cpuPrev = new Map<string, { usec: number; at: number; pct?: number }>();

/** % de CPU (estilo top: 100% = um núcleo inteiro) a partir do tempo acumulado entre duas leituras. */
function cpuPercent(key: string, usec: number) {
  const now = Date.now();
  const prev = cpuPrev.get(key);
  if (prev && now - prev.at < 800) return prev.pct;
  const pct = prev && usec >= prev.usec ? ((usec - prev.usec) / ((now - prev.at) * 1000)) * 100 : undefined;
  cpuPrev.set(key, { usec, at: now, pct });
  return pct;
}

const tunnelCache = new Map<string, string | null>();

/** URL pública de um quick tunnel do cloudflared, lida dos logs do container. */
async function quickTunnelUrl(c: Container) {
  const key = `${c.id}:${c.startedAt}`;
  if (tunnelCache.has(key)) return tunnelCache.get(key)!;
  const lines = await recentLogs(c, 500).catch(() => []);
  const url = lines.map((l) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(l.m)?.[0]).filter(Boolean).pop() ?? null;
  // Sem URL ainda (túnel subindo): não guarda no cache pra tentar de novo.
  if (url) tunnelCache.set(key, url);
  return url;
}

const tunnelTarget = (cmd: string[]) => {
  const i = cmd.findIndex((a) => a === '--url' || a.startsWith('--url='));
  if (i < 0) return null;
  const raw = cmd[i]!.includes('=') ? cmd[i]!.split('=').slice(1).join('=') : cmd[i + 1];
  try {
    const u = new URL(raw!);
    return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  } catch {
    return null;
  }
};

const dockerState = (c: Container): [State, string] => {
  if (c.state === 'running') return [c.health === 'unhealthy' ? 'failed' : 'running', c.health === 'unhealthy' ? 'rodando, mas com healthcheck falhando' : 'rodando'];
  if (c.state === 'restarting') return ['starting', 'reiniciando'];
  if (c.state === 'paused') return ['stopped', 'pausado'];
  if (c.state === 'created') return ['stopped', 'criado, nunca iniciado'];
  const code = c.exitCode ?? 0;
  // 0, 137 (SIGKILL) e 143 (SIGTERM) são paradas normais.
  return [code === 0 || code === 137 || code === 143 ? 'stopped' : 'failed', code ? `parado (saiu com código ${code})` : 'parado'];
};

const unitState = (u: Unit): [State, string] => {
  if (u.active === 'active') return ['running', u.sub === 'running' ? 'rodando' : u.sub];
  if (u.active === 'activating' || u.active === 'reloading') return ['starting', 'iniciando'];
  if (u.active === 'failed') return ['failed', 'falhou'];
  return ['stopped', 'parado'];
};

let handles = new Map<string, Handle>();
let containersCache: Container[] = [];
let lastSnapshot: Snapshot | null = null;
/** Últimos serviços fixados vistos: se sumirem (processo morto), continuam na lista como parados. */
const pinnedGhosts = new Map<string, Service>();

async function build(): Promise<Snapshot> {
  const cfg = config();
  const [socks, containers, ts, table, own] = await Promise.all([sockets(), listContainers(), tailscaleState(), processTable(), ownUnitNames()]);
  const nets = localNetworks();
  const listens = listening(socks);
  const claimed = new Set<Sock>();
  const services: Service[] = [];
  const nextHandles = new Map<string, Handle>();
  const selfDns = ts.self?.dnsName;

  const base = (key: string, kind: Kind, name: string): Service => ({
    key,
    kind,
    name,
    detectedName: name,
    state: 'running',
    stateText: 'rodando',
    ports: [],
    links: [],
    exposure: 'local',
    connections: 0,
    actions: [],
    logs: true,
    accessLog: false,
    pinned: false,
    hidden: false,
    background: false,
  });

  // 1. Containers Docker (inclusive os parados).
  for (const c of containers ?? []) {
    const compose = c.labels['com.docker.compose.project'];
    const composeService = c.labels['com.docker.compose.service'];
    const svc = base(`docker:${c.name}`, 'docker', composeService ?? c.name);
    svc.project = compose ?? (await projectOf(c.labels['com.docker.compose.project.working_dir']))?.name;
    svc.ports = c.ports
      .filter((p) => p.type === 'tcp')
      .map((p) => ({ port: p.public, hosts: [p.ip], scope: scopeOf([p.ip]), protocol: KNOWN_PROTOCOLS[p.private], inner: p.private }));
    for (const l of listens) if (svc.ports.some((p) => p.port === l.local.port) && !l.procs.length) claimed.add(l);
    [svc.state, svc.stateText] = dockerState(c);
    svc.health = c.health;
    svc.image = c.image;
    svc.detail = c.image.replace(/@sha256:.*/, '');
    svc.containerId = c.id;
    svc.cmd = c.cmd.join(' ');
    svc.startedAt = c.state === 'running' ? c.startedAt : c.finishedAt;
    svc.actions = c.state === 'running' ? ['restart', 'stop'] : ['start'];
    svc.accessLog = ACCESS_LOG_IMAGE.test(c.image);
    services.push(svc);
    nextHandles.set(svc.key, { container: c, cgroup: `/system.slice/docker-${c.id}.scope` });
  }

  // 2. Units systemd do usuário: as escritas à mão e as que têm socket escutando.
  const isUserService = (l: Sock) => Boolean(l.cgroup?.includes('/user@') && cgroupLeaf(l.cgroup)?.endsWith('.service'));
  const fromSockets = listens.filter(isUserService).map((l) => cgroupLeaf(l.cgroup)!);
  const units = await showUnits([...new Set([...own, ...fromSockets])], true, new Set(own));
  for (const u of units) {
    if (u.type === 'oneshot' && u.active !== 'active') continue;
    const details = u.mainPid ? await procDetails(u.mainPid) : null;
    const unitProject = (await projectOf(u.workingDir || details?.cwd))?.name;
    const mine: Sock[] = [];
    for (const l of listens) {
      if (!isUserService(l) || cgroupLeaf(l.cgroup) !== u.id) continue;
      const pid = l.procs[0]?.pid;
      // Filho rodando fora do projeto da unit (ex.: dev server aberto numa sessão do
      // claude.remote) herda o cgroup dela, mas é outro serviço: fica como processo solto.
      if (pid && pid !== u.mainPid) {
        const other = await projectOf((await procDetails(pid)).cwd);
        if (other?.name !== unitProject) continue;
      }
      mine.push(l);
      claimed.add(l);
    }
    const svc = base(`unit:${u.name}`, 'unit', u.name);
    svc.project = unitProject;
    svc.ports = groupPorts(mine);
    [svc.state, svc.stateText] = unitState(u);
    svc.detail = u.description !== u.id ? u.description : undefined;
    svc.unit = u.id;
    svc.pid = u.mainPid || undefined;
    svc.cwd = u.workingDir || details?.cwd;
    svc.cmd = details?.cmdline.join(' ');
    svc.startedAt = u.startedAt;
    svc.actions = svc.state === 'running' || svc.state === 'starting' ? ['restart', 'stop'] : ['start'];
    svc.background = !u.own && !svc.project;
    services.push(svc);
    nextHandles.set(svc.key, { unit: u, cgroup: u.cgroup });
  }

  // 3. Processos soltos do usuário (rodando num terminal, por exemplo), agrupados por PID.
  const byPid = new Map<number, Sock[]>();
  for (const l of listens) {
    if (claimed.has(l) || !l.procs.length || SKIP_CGROUP.test(l.cgroup ?? '')) continue;
    const pid = l.procs[0]!.pid;
    byPid.set(pid, [...(byPid.get(pid) ?? []), l]);
    claimed.add(l);
  }
  const procEntries = await mapLimit([...byPid.entries()], 8, async ([pid, list]) => ({ pid, list, d: await procDetails(pid) }));
  const usedKeys = new Set<string>();
  for (const { pid, list, d } of procEntries) {
    const p = table.get(pid);
    const comm = p?.comm ?? list[0]!.procs[0]!.name;
    const project = await projectOf(d.cwd);
    // Fora de um projeto (apps do desktop, Electron…) a detecção de framework só gera ruído.
    const framework = project ? frameworkOf(d.cmdline, comm) : undefined;
    const ports = groupPorts(list);
    let key = `proc:${project?.name ?? prettyProcess(comm)}:${framework ?? comm}`;
    if (usedKeys.has(key)) key += `:${ports[0]?.port}`;
    usedKeys.add(key);
    const svc = base(key, 'process', project?.name ?? prettyProcess(comm));
    svc.project = project?.name;
    svc.ports = ports;
    svc.detail = framework ?? comm;
    svc.pid = pid;
    svc.cwd = d.cwd;
    svc.cmd = d.cmdline.join(' ');
    svc.startedAt = p?.start;
    svc.actions = p?.uid === MY_UID ? ['kill'] : [];
    svc.background = !project;
    const override = cfg.services[key];
    const logFile = override?.logFile ?? fileTarget(d);
    svc.logs = Boolean(logFile);
    svc.logHint = logFile ? undefined : logHint(d);
    services.push(svc);
    nextHandles.set(key, { pid, logFile });
  }

  // 4. O resto: serviços do sistema e sockets de outros usuários (sem PID visível).
  const sysGroups = new Map<string, Sock[]>();
  for (const l of listens) {
    if (claimed.has(l) || /\/(docker|tailscaled)\.service$/.test(l.cgroup ?? '')) continue;
    const leaf = cgroupLeaf(l.cgroup) ?? `porta-${l.local.port}`;
    sysGroups.set(leaf, [...(sysGroups.get(leaf) ?? []), l]);
  }
  const sysUnits = await showUnits([...sysGroups.keys()].filter((n) => n.endsWith('.service')), false);
  for (const [leaf, list] of sysGroups) {
    const u = sysUnits.find((x) => x.id === leaf);
    const name = leaf.replace(/\.(service|scope)$/, '').replace(/^app-(.+?)-\d+$/, '$1');
    const svc = base(`sys:${leaf}`, 'system', name);
    svc.ports = groupPorts(list);
    svc.detail = u?.description;
    svc.unit = u?.id;
    svc.startedAt = u?.startedAt;
    svc.background = true;
    svc.logs = Boolean(u);
    if (!u) svc.logHint = 'Processo de outro usuário, sem unit systemd associada.';
    services.push(svc);
    nextHandles.set(svc.key, { unit: u, cgroup: list[0]!.cgroup });
  }

  // Endereços de acesso por porta.
  for (const svc of services) {
    for (const p of svc.ports) {
      if (p.protocol) continue;
      const add = (kind: LinkKind, host: string) => svc.links.push({ kind, url: `http://${host}:${p.port}` });
      if (p.scope === 'local' || p.scope === 'all') add('local', 'localhost');
      if (p.scope === 'all' && nets.lanIp) add('lan', nets.lanIp);
      if ((p.scope === 'all' || p.scope === 'tailnet') && selfDns) add('tailnet', selfDns);
      if (p.scope === 'lan') for (const h of p.hosts) add('lan', h);
    }
  }

  // Tailscale serve: vira link do serviço de destino, ou item órfão quando nada escuta lá.
  for (const s of ts.serve) {
    const target = s.targetPort === null ? undefined : services.find((svc) => svc.ports.some((p) => p.port === s.targetPort));
    const link: Link = { kind: s.funnel ? 'public' : 'tailnet', url: s.url, servePort: s.httpsPort, servePath: s.path, note: s.funnel ? 'Funnel: aberto na internet' : 'Tailscale serve' };
    if (target) {
      target.links.push(link);
      if (!target.actions.includes('unshare')) target.actions.push('unshare');
      continue;
    }
    const svc = base(`serve:${s.httpsPort}${s.path}`, 'serve', `${s.url.replace(/^https:\/\//, '')}`);
    svc.state = 'stopped';
    svc.stateText = 'nada escutando no destino';
    svc.detail = `Tailscale serve apontando para ${s.target}`;
    svc.links.push(link);
    svc.actions = ['unshare'];
    svc.logs = false;
    services.push(svc);
    nextHandles.set(svc.key, { serve: s });
  }

  // Quick tunnels do Cloudflare: link público no container de destino.
  for (const c of containers ?? []) {
    if (!/cloudflared/i.test(c.image) || c.state !== 'running') continue;
    const tunnel = services.find((s) => s.containerId === c.id)!;
    const target = tunnelTarget(c.cmd);
    const url = await quickTunnelUrl(c);
    tunnel.detail = target ? `Túnel Cloudflare para ${target.host}:${target.port}` : 'Túnel Cloudflare nomeado';
    if (!url) continue;
    tunnel.links.push({ kind: 'public', url, note: 'Quick tunnel do Cloudflare' });
    const project = c.labels['com.docker.compose.project'];
    const dest = target
      ? services.find(
          (s) =>
            s.kind === 'docker' &&
            s.containerId !== c.id &&
            ((project && s.project === project && s.detectedName === target.host) ||
              nextHandles.get(s.key)?.container?.networks.some((n) => n.aliases.includes(target.host)) ||
              s.ports.some((p) => ['localhost', '127.0.0.1', 'host.docker.internal'].includes(target.host) && p.port === target.port)),
        )
      : undefined;
    dest?.links.push({ kind: 'public', url, note: `Pelo túnel ${tunnel.name}` });
  }

  // Sonda HTTP, métricas e conexões.
  const conns = serverConnections(socks);
  const servePorts = new Map(ts.serve.map((s) => [s.httpsPort, s.targetPort]));
  const noProbe = new Set(cfg.noProbePorts);
  await mapLimit(services, 8, async (svc) => {
    const h = nextHandles.get(svc.key);
    for (const p of svc.ports) if (!p.protocol && noProbe.has(p.port)) p.protocol = 'Não sondada';
    if (svc.state === 'running') {
      const identity = svc.containerId ?? String(svc.pid ?? svc.key);
      await Promise.all(
        svc.ports
          .filter((p) => !p.protocol)
          .map(async (p) => {
            const host = p.scope === 'local' || p.scope === 'all' ? (p.hosts.every((x) => x === '::1') ? '::1' : '127.0.0.1') : p.hosts[0]!;
            p.http = await probe(host, p.port, identity);
            if (!p.http && svc.ports.length) p.protocol = 'TCP';
          }),
      );
      // Porta que não fala HTTP não ganha link clicável.
      svc.links = svc.links.filter((l) => l.kind === 'public' || l.servePort || svc.ports.some((p) => p.http && l.url.endsWith(`:${p.port}`)));
      for (const p of svc.ports) {
        if (!p.http?.https) continue;
        for (const l of svc.links) if (l.url.endsWith(`:${p.port}`)) l.url = l.url.replace(/^http:/, 'https:');
      }
    } else if (svc.kind !== 'serve') svc.links = svc.links.filter((l) => l.kind === 'public');

    if (h?.cgroup && svc.kind !== 'serve' && svc.state !== 'stopped') {
      const usage = await cgroupUsage(h.cgroup);
      if (usage) {
        svc.cpu = cpuPercent(svc.key, usage.usec);
        svc.mem = usage.mem;
      }
    } else if (h?.pid) {
      const tree = descendants(table, h.pid);
      svc.cpu = cpuPercent(svc.key, tree.reduce((a, p) => a + p.cpuUsec, 0));
      svc.mem = tree.reduce((a, p) => a + p.rss, 0);
    }

    const ports = new Set(svc.ports.map((p) => p.port));
    svc.connections = conns.filter((c) => ports.has(c.localPort) || (isTailnet(c.localHost) && ports.has(servePorts.get(c.localPort) ?? -1))).length;
  });

  // Exposição e ajustes do usuário.
  for (const svc of services) {
    if (svc.links.some((l) => l.kind === 'public')) svc.exposure = 'public';
    else if (svc.ports.some((p) => p.scope === 'all' || p.scope === 'lan')) svc.exposure = 'lan';
    else if (svc.links.some((l) => l.kind === 'tailnet') || svc.ports.some((p) => p.scope === 'tailnet')) svc.exposure = 'tailnet';
    if (svc.state === 'running' && !svc.background && ts.running && shareablePort(svc) && !svc.links.some((l) => l.servePort)) svc.actions.push('share');
    const o = cfg.services[svc.key];
    if (o?.name) svc.name = o.name;
    svc.pinned = Boolean(o?.pinned);
    svc.hidden = Boolean(o?.hidden);
    if (o?.accessLog !== undefined) svc.accessLog = o.accessLog;
  }

  // Fixados que sumiram (processo encerrado) continuam visíveis como parados.
  for (const [key, ghost] of pinnedGhosts) {
    if (!cfg.services[key]?.pinned) pinnedGhosts.delete(key);
    else if (!services.some((s) => s.key === key)) {
      services.push({ ...ghost, state: 'stopped', stateText: 'não está rodando', pid: undefined, cpu: undefined, mem: undefined, connections: 0, actions: [], logs: false, links: [], ports: ghost.ports.map((p) => ({ ...p, http: null })) });
    }
  }
  for (const svc of services) if (svc.pinned && svc.state === 'running') pinnedGhosts.set(svc.key, svc);

  services.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(a.background) - Number(b.background) ||
      // Projetos em ordem alfabética; o que não tem projeto vai pro fim.
      Number(!a.project) - Number(!b.project) ||
      (a.project ?? '').localeCompare(b.project ?? '') ||
      (a.ports[0]?.port ?? 1e6) - (b.ports[0]?.port ?? 1e6) ||
      a.name.localeCompare(b.name),
  );

  handles = nextHandles;
  containersCache = containers ?? [];
  return {
    at: Date.now(),
    services,
    docker: containers !== null,
    tailscale: { running: ts.running, dnsName: selfDns, ip: ts.self?.ips[0] },
    lanIp: nets.lanIp,
  };
}

/** Porta HTTP alcançável por 127.0.0.1, que é pra onde o `tailscale serve` aponta. */
export const shareablePort = (svc: Service) => svc.ports.find((p) => p.http && (p.scope === 'local' || p.scope === 'all'));

/** Saída padrão redirecionada pra um arquivo comum dá pra seguir com tail. */
function fileTarget(d: ProcDetails) {
  for (const t of [d.stdout, d.stderr]) if (t?.startsWith('/') && !t.startsWith('/dev/') && !t.endsWith('(deleted)')) return t;
  return undefined;
}

function logHint(d: ProcDetails) {
  const t = d.stdout ?? '';
  if (t.startsWith('/dev/pts/') || t.startsWith('/dev/tty')) return `A saída vai direto pro terminal (${t}). Rode com "> arquivo.log 2>&1" ou informe um arquivo de log.`;
  if (t.startsWith('pipe:')) return 'A saída vai por um pipe pra outro processo. Informe um arquivo de log, se houver.';
  if (t.startsWith('socket:')) return 'A saída vai por um socket (provavelmente o journal de outra unit).';
  return 'Não foi possível descobrir pra onde vai a saída desse processo.';
}

const snapshotCached = cached(2_000, build);

export async function servicesSnapshot(force = false) {
  const prev = lastSnapshot;
  const snap = await snapshotCached(force);
  if (snap !== prev) {
    if (prev && config().settings.notifyPinned) notifyPinnedChanges(prev, snap);
    lastSnapshot = snap;
  }
  return snap;
}

function notifyPinnedChanges(prev: Snapshot, next: Snapshot) {
  for (const svc of next.services) {
    if (!svc.pinned) continue;
    const before = prev.services.find((s) => s.key === svc.key);
    if (!before || before.state === svc.state) continue;
    if (before.state === 'running' && svc.state !== 'running') notify(`${svc.name} parou`, svc.stateText, 'critical');
    else if (svc.state === 'running') notify(`${svc.name} voltou`, 'O serviço está rodando de novo.', 'low');
  }
}

export const handleOf = (key: string) => handles.get(key);
export const lastServices = () => lastSnapshot;

/** Container dono de um IP das redes do Docker, pra dar nome a quem acessa. */
export const containerByIp = (ip: string) => containersCache.find((c) => c.networks.some((n) => n.ip === ip));
