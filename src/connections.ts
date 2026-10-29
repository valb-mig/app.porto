import { listensOn, type Sock } from './sockets.ts';

export type Conn = {
  localHost: string;
  localPort: number;
  peerHost: string;
  peerPort: number;
  /** Processo do outro lado, quando a conexão nasce nesta máquina (loopback ou IP próprio). */
  client?: { pid?: number; name?: string; cgroup?: string };
};

/**
 * Conexões estabelecidas do lado servidor: as que chegam numa porta que está escutando.
 * Conexões locais aparecem duas vezes no `ss` (cliente e servidor); o lado cliente serve
 * pra descobrir quem está acessando.
 */
export function serverConnections(socks: Sock[]): Conn[] {
  const listenByPort = new Map<number, Sock[]>();
  const byLocal = new Map<string, Sock>();
  for (const s of socks) {
    if (s.state === 'LISTEN' && s.local.port !== null) {
      const list = listenByPort.get(s.local.port);
      if (list) list.push(s);
      else listenByPort.set(s.local.port, [s]);
    } else if (s.state === 'ESTAB') byLocal.set(`${s.local.host}|${s.local.port}`, s);
  }
  const out: Conn[] = [];
  for (const s of byLocal.values()) {
    if (s.local.port === null || s.peer.port === null) continue;
    const listeners = listenByPort.get(s.local.port);
    if (!listeners?.some((l) => listensOn(l, s.local.host))) continue;
    const other = byLocal.get(`${s.peer.host}|${s.peer.port}`);
    // As sondas HTTP do próprio Porto não contam como acesso.
    if (other?.procs.some((p) => p.pid === process.pid)) continue;
    out.push({
      localHost: s.local.host,
      localPort: s.local.port,
      peerHost: s.peer.host,
      peerPort: s.peer.port,
      client: other ? { pid: other.procs[0]?.pid, name: other.procs[0]?.name, cgroup: other.cgroup } : undefined,
    });
  }
  return out;
}
