import { cached, run } from './util.ts';

export type TsDevice = { name: string; dnsName: string; os: string; ips: string[]; online: boolean; lastSeen?: string; self: boolean };

export type TsServe = {
  url: string;
  host: string;
  httpsPort: number;
  path: string;
  target: string;
  /** Porta local para onde o serve aponta (null quando é arquivo, texto ou destino remoto). */
  targetPort: number | null;
  funnel: boolean;
  tcp: boolean;
};

export type TsState = {
  available: boolean;
  running: boolean;
  self?: TsDevice;
  peers: TsDevice[];
  serve: TsServe[];
};

type RawPeer = { HostName: string; DNSName: string; OS: string; TailscaleIPs?: string[]; Online: boolean; LastSeen?: string };

const toDevice = (p: RawPeer, self: boolean): TsDevice => ({
  name: p.HostName,
  dnsName: p.DNSName.replace(/\.$/, ''),
  os: p.OS,
  ips: p.TailscaleIPs ?? [],
  online: self || p.Online,
  lastSeen: p.LastSeen?.startsWith('0001') ? undefined : p.LastSeen,
  self,
});

function localPort(target: string): number | null {
  const m = /^(?:https?(?:\+insecure)?:\/\/|tcp:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?/.exec(target);
  if (!m) return null;
  return m[1] ? Number(m[1]) : target.startsWith('https') ? 443 : 80;
}

type RawServe = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

function parseServe(raw: RawServe): TsServe[] {
  const out: TsServe[] = [];
  for (const [hostPort, web] of Object.entries(raw.Web ?? {})) {
    const [host, portText] = hostPort.split(':') as [string, string];
    const httpsPort = Number(portText);
    const funnel = Boolean(raw.AllowFunnel?.[hostPort]);
    for (const [path, h] of Object.entries(web.Handlers ?? {})) {
      const target = h.Proxy ?? (h.Path ? `arquivo ${h.Path}` : 'texto fixo');
      out.push({
        url: `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}${path === '/' ? '' : path}`,
        host,
        httpsPort,
        path,
        target,
        targetPort: h.Proxy ? localPort(h.Proxy) : null,
        funnel,
        tcp: false,
      });
    }
  }
  for (const [portText, tcp] of Object.entries(raw.TCP ?? {})) {
    if (!tcp.TCPForward) continue;
    out.push({
      url: `tcp://:${portText}`,
      host: '',
      httpsPort: Number(portText),
      path: '/',
      target: tcp.TCPForward,
      targetPort: localPort(tcp.TCPForward),
      funnel: false,
      tcp: true,
    });
  }
  return out;
}

export const tailscaleState = cached(5_000, async (): Promise<TsState> => {
  const status = await run('tailscale', ['status', '--json']);
  if (!status.stdout.trim().startsWith('{')) return { available: false, running: false, peers: [], serve: [] };
  const data = JSON.parse(status.stdout) as { BackendState: string; Self?: RawPeer; Peer?: Record<string, RawPeer> };
  const running = data.BackendState === 'Running';
  const serve = running ? await run('tailscale', ['serve', 'status', '--json']) : null;
  let serveList: TsServe[] = [];
  try {
    if (serve?.stdout.trim().startsWith('{')) serveList = parseServe(JSON.parse(serve.stdout) as RawServe);
  } catch {
    // Formato inesperado: segue sem o mapa do serve.
  }
  // Com MagicDNS desligado o serve.host vem vazio; usa o nome do próprio nó.
  const self = data.Self ? toDevice(data.Self, true) : undefined;
  for (const s of serveList) if (s.tcp && self) s.url = `tcp://${self.dnsName}:${s.httpsPort}`;
  return {
    available: true,
    running,
    self,
    peers: Object.values(data.Peer ?? {}).map((p) => toDevice(p, false)),
    serve: serveList,
  };
});

/** Portas HTTPS que aceitam Funnel primeiro; depois uma faixa alta só pra tailnet. */
const SERVE_PORTS = [443, 8443, 10000, ...Array.from({ length: 50 }, (_, i) => 10001 + i)];

export async function serveAdd(localPortNumber: number, https: boolean) {
  const st = await tailscaleState(true);
  if (!st.running) throw new Error('O Tailscale não está conectado.');
  const used = new Set(st.serve.map((s) => s.httpsPort));
  const port = SERVE_PORTS.find((p) => !used.has(p));
  if (!port) throw new Error('Nenhuma porta HTTPS livre no serve.');
  const target = `${https ? 'https+insecure' : 'http'}://127.0.0.1:${localPortNumber}`;
  const res = await run('tailscale', ['serve', '--bg', '--yes', `--https=${port}`, target], 20_000);
  if (!res.ok) throw new Error(res.stderr.trim() || 'tailscale serve falhou');
  const fresh = await tailscaleState(true);
  return fresh.serve.find((s) => s.httpsPort === port)?.url ?? `https://${st.self?.dnsName}:${port}`;
}

export async function serveRemove(httpsPort: number, path: string) {
  const args = ['serve', '--yes', `--https=${httpsPort}`];
  if (path && path !== '/') args.push(`--set-path=${path}`);
  const res = await run('tailscale', [...args, 'off'], 20_000);
  if (!res.ok) throw new Error(res.stderr.trim() || 'tailscale serve off falhou');
  await tailscaleState(true);
}
