import { logSourceOf } from './logs.ts';
import { classifyIp, localNetworks, type PeerKind } from './net.ts';
import { containerByIp, type Service } from './services.ts';

export type Req = {
  t: number;
  ip: string;
  kind: PeerKind;
  /** Quem fez a requisição: IP, container ou túnel. */
  client: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  referer?: string;
  ua?: string;
  device: string;
  bot: boolean;
};

// Formato combined do nginx/apache, com um campo extra opcional no fim (X-Forwarded-For).
const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)(?: [^"]*)?" (\d{3}) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?(?: "((?:[^"\\]|\\.)*)")?/;
const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|txt|xml|json)(\?|$)|^\/(_next|build|assets|livewire[^/]*\/(livewire|update))/i;

export function deviceOf(ua = ''): { device: string; bot: boolean } {
  if (/bot|crawl|spider|slurp|curl|wget|python-requests|go-http|httpclient|uptime|monitor|headless/i.test(ua)) return { device: 'Robô ou script', bot: true };
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  return { device: [browser, os].filter(Boolean).join(' no ') || 'Desconhecido', bot: false };
}

function parseTime(s: string) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/.exec(s);
  return m ? Date.parse(`${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`) : NaN;
}

export function parseAccessLine(line: string, nets = localNetworks()): Req | null {
  const m = COMBINED.exec(line);
  if (!m) return null;
  const t = parseTime(m[2]!);
  if (Number.isNaN(t)) return null;
  const forwarded = m[9]?.split(',')[0]?.trim();
  const ip = forwarded && forwarded !== '-' ? forwarded : m[1]!;
  const kind = classifyIp(ip, nets);
  let client = ip;
  // O gateway da bridge do Docker é a própria máquina (acesso pelo navegador local).
  if (kind === 'self' || kind === 'local') client = 'Esta máquina';
  else if (kind === 'docker') {
    const ct = containerByIp(ip);
    if (ct) client = /cloudflared/i.test(ct.image) ? 'Túnel Cloudflare' : ct.name;
  }
  const ua = m[8] && m[8] !== '-' ? m[8] : undefined;
  return {
    t,
    ip,
    kind,
    client,
    method: m[3]!,
    path: m[4]!,
    status: Number(m[5]),
    bytes: m[6] === '-' ? 0 : Number(m[6]),
    referer: m[7] && m[7] !== '-' ? m[7] : undefined,
    ua,
    ...deviceOf(ua),
  };
}

const count = <T>(items: T[], key: (i: T) => string) => {
  const map = new Map<string, number>();
  for (const i of items) map.set(key(i), (map.get(key(i)) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
};

export async function requestsOf(svc: Service, tail = 3_000) {
  const src = logSourceOf(svc);
  if (!src.ok) return { available: false as const, reason: src.reason };
  const nets = localNetworks();
  const lines = await src.recent(tail);
  const reqs = lines
    .map((l) => parseAccessLine(l.m, nets))
    // As sondas e o favicon do próprio Porto não são visitas.
    .filter((r): r is Req => r !== null && !r.ua?.startsWith('Porto/') && !r.ua?.includes('(Porto favicon)'));
  const pages = reqs.filter((r) => !ASSET.test(r.path));
  const hour = 3600_000;
  const now = Date.now();
  // Requisições de páginas por hora nas últimas 24h (índice 23 = hora atual).
  const perHour = Array.from({ length: 24 }, () => 0);
  for (const r of pages) {
    const ago = Math.floor((now - r.t) / hour);
    if (ago >= 0 && ago < 24) perHour[23 - ago]!++;
  }
  // Uma "visita" = mesmo cliente + mesmo navegador.
  const visitors = new Set(reqs.filter((r) => !r.bot).map((r) => `${r.client}|${r.ua}`));
  const behindTunnel = reqs.some((r) => r.client === 'Túnel Cloudflare');
  return {
    available: true as const,
    scanned: lines.length,
    total: reqs.length,
    pages: pages.length,
    visitors: visitors.size,
    status: {
      ok: reqs.filter((r) => r.status < 300).length,
      redirect: reqs.filter((r) => r.status >= 300 && r.status < 400).length,
      clientError: reqs.filter((r) => r.status >= 400 && r.status < 500).length,
      serverError: reqs.filter((r) => r.status >= 500).length,
    },
    topPages: count(pages, (r) => r.path.split('?')[0]!).slice(0, 10),
    devices: count(reqs.filter((r) => !ASSET.test(r.path)), (r) => r.device).slice(0, 8),
    clients: count(pages, (r) => r.client).slice(0, 10),
    perHour,
    recent: pages.slice(-150).reverse(),
    /** O nginx só enxerga o IP do túnel; o IP real vem no header Cf-Connecting-Ip. */
    hint: behindTunnel ? 'As requisições chegam pelo túnel da Cloudflare, então o IP de quem acessa não aparece. Pra registrar o IP real, inclua "$http_cf_connecting_ip" no log_format do nginx.' : undefined,
  };
}
