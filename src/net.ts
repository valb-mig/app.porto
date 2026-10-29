import { networkInterfaces } from 'node:os';

export type Addr = { host: string; port: number | null; iface?: string };

/** Endereço no formato do `ss`: `127.0.0.1:80`, `*:80`, `[::1]:80`, `100.1.2.3%tailscale0:443`. */
export function parseAddr(raw: string): Addr {
  const idx = raw.lastIndexOf(':');
  const portText = raw.slice(idx + 1);
  let host = raw.slice(0, idx);
  let iface: string | undefined;
  const pct = host.lastIndexOf('%');
  if (pct > host.lastIndexOf(']')) {
    iface = host.slice(pct + 1);
    host = host.slice(0, pct);
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.startsWith('::ffff:') && host.includes('.')) host = host.slice(7);
  return { host, port: portText === '*' ? null : Number(portText), iface };
}

export const isWildcard = (host: string) => host === '*' || host === '0.0.0.0' || host === '::';
export const isLoopback = (host: string) => host.startsWith('127.') || host === '::1' || host === 'localhost';
export const isTailnet = (host: string) => inCidr(host, '100.64.0.0', 10) || host.toLowerCase().startsWith('fd7a:115c:a1e0:');

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(a / size) === Math.floor(b / size);
}

export type PeerKind = 'self' | 'local' | 'tailnet' | 'docker' | 'lan' | 'internet';

type Net = { address: string; bits: number; iface: string };

/** Endereços e sub-redes desta máquina, separados por papel (LAN, bridges do Docker, Tailscale). */
export function localNetworks() {
  const self = new Set<string>();
  const docker: Net[] = [];
  const lan: Net[] = [];
  let lanIp: string | undefined;
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const n of list ?? []) {
      self.add(n.address);
      if (n.internal || n.family !== 'IPv4') continue;
      const bits = Number(n.cidr?.split('/')[1] ?? 32);
      if (/^(docker|br-|veth)/.test(iface)) docker.push({ address: n.address, bits, iface });
      else if (!iface.startsWith('tailscale') && !isTailnet(n.address)) {
        lan.push({ address: n.address, bits, iface });
        lanIp ??= n.address;
      }
    }
  }
  return { self, docker, lan, lanIp };
}

export function classifyIp(ip: string, nets = localNetworks()): PeerKind {
  if (isLoopback(ip)) return 'local';
  if (nets.self.has(ip)) return 'self';
  if (isTailnet(ip)) return 'tailnet';
  if (nets.docker.some((n) => inCidr(ip, n.address, n.bits))) return 'docker';
  if (nets.lan.some((n) => inCidr(ip, n.address, n.bits))) return 'lan';
  if (inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '192.168.0.0', 16)) return 'lan';
  if (inCidr(ip, '172.16.0.0', 12)) return 'docker';
  if (/^f[cd]|^fe[89ab]/i.test(ip)) return 'lan';
  return 'internet';
}
