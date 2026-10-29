import { parseAddr, type Addr } from './net.ts';
import { cached, run } from './util.ts';

export type Sock = {
  state: 'LISTEN' | 'ESTAB';
  local: Addr;
  peer: Addr;
  /** Só vem preenchido para processos do próprio usuário (o `ss` sem root não enxerga os outros). */
  procs: { name: string; pid: number }[];
  uid?: number;
  /** cgroup do socket, mesmo de outros usuários: é o que revela docker-proxy, tailscaled, containerd… */
  cgroup?: string;
};

const PROC_RE = /\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g;

function parseLine(line: string): Sock | null {
  const tokens = line.trim().split(/\s+/);
  const state = tokens[0];
  if (state !== 'LISTEN' && state !== 'ESTAB') return null;
  if (!tokens[3] || !tokens[4]) return null;
  const procs = [...line.matchAll(PROC_RE)].map((m) => ({ name: m[1]!, pid: Number(m[2]) }));
  const uid = /\buid:(\d+)/.exec(line)?.[1];
  const cgroup = /\bcgroup:(\S+)/.exec(line)?.[1];
  return {
    state,
    local: parseAddr(tokens[3]),
    peer: parseAddr(tokens[4]),
    procs,
    uid: uid === undefined ? undefined : Number(uid),
    cgroup,
  };
}

/** Snapshot de todos os sockets TCP (escutando e conectados), compartilhado entre os módulos. */
export const sockets = cached(1_200, async (): Promise<Sock[]> => {
  const res = await run('ss', ['-tanpeH']);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .map(parseLine)
    .filter((s): s is Sock => s !== null);
});

export const listening = (socks: Sock[]) => socks.filter((s) => s.state === 'LISTEN' && s.local.port !== null);

/** Nome da unit systemd (ou scope) dona do cgroup: `.../app.slice/my-film-list.service` → `my-film-list.service`. */
export const cgroupLeaf = (cgroup?: string) => cgroup?.split('/').pop() || undefined;

/** O socket escuta nesse endereço local? Considera os curingas `0.0.0.0`, `::` e `*`. */
export function listensOn(listen: Sock, host: string) {
  const h = listen.local.host;
  if (h === host) return true;
  if (h === '*' || h === '::') return true;
  if (h === '0.0.0.0') return !host.includes(':');
  return false;
}
