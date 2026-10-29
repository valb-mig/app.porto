import { request } from 'node:http';
import { mapLimit } from './util.ts';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

export type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: { ip: string; private: number; public: number; type: string }[];
  labels: Record<string, string>;
  networks: { name: string; ip: string; aliases: string[] }[];
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  health?: string;
  restarts: number;
  tty: boolean;
  cmd: string[];
};

type Res = { status: number; body: Buffer };

function call(method: string, path: string, timeoutMs = 8_000): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: SOCKET, path, method, timeout: timeoutMs, headers: { Host: 'docker' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('docker: timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function json<T>(path: string): Promise<T> {
  const res = await call('GET', path);
  if (res.status >= 400) throw new Error(`docker ${res.status}: ${res.body.toString().slice(0, 200)}`);
  return JSON.parse(res.body.toString()) as T;
}

const parseTime = (s?: string) => {
  if (!s || s.startsWith('0001-')) return undefined;
  const t = Date.parse(s.replace(/\.(\d{3})\d*/, '.$1'));
  return Number.isNaN(t) ? undefined : t;
};

type ListItem = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
  Labels: Record<string, string> | null;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; Aliases?: string[] | null; DNSNames?: string[] | null }> };
};

type Inspect = {
  State: { StartedAt?: string; FinishedAt?: string; ExitCode?: number; Health?: { Status?: string } };
  RestartCount?: number;
  Config: { Tty?: boolean; Cmd?: string[] | null; Entrypoint?: string[] | null };
};

/** null quando o Docker não está disponível (daemon parado ou sem permissão no socket). */
export async function listContainers(): Promise<Container[] | null> {
  let list: ListItem[];
  try {
    list = await json<ListItem[]>('/containers/json?all=1');
  } catch {
    return null;
  }
  return mapLimit(list, 8, async (c): Promise<Container> => {
    const info = await json<Inspect>(`/containers/${c.Id}/json`).catch(() => null);
    const seen = new Set<string>();
    const ports = c.Ports.filter((p) => p.PublicPort)
      .map((p) => ({ ip: p.IP ?? '0.0.0.0', private: p.PrivatePort, public: p.PublicPort!, type: p.Type }))
      // O Docker repete a porta para IPv4 e IPv6.
      .filter((p) => {
        const k = `${p.public}/${p.type}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    return {
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports,
      labels: c.Labels ?? {},
      networks: Object.entries(c.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({
        name,
        ip: n.IPAddress ?? '',
        aliases: [...(n.Aliases ?? []), ...(n.DNSNames ?? [])],
      })),
      startedAt: parseTime(info?.State.StartedAt),
      finishedAt: parseTime(info?.State.FinishedAt),
      exitCode: info?.State.ExitCode,
      health: info?.State.Health?.Status,
      restarts: info?.RestartCount ?? 0,
      tty: info?.Config.Tty ?? false,
      cmd: [...(info?.Config.Entrypoint ?? []), ...(info?.Config.Cmd ?? [])],
    };
  });
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart') {
  const q = action === 'start' ? '' : '?t=10';
  const res = await call('POST', `/containers/${id}/${action}${q}`, 30_000);
  // 304: já estava no estado pedido.
  if (res.status >= 400) throw new Error(JSON.parse(res.body.toString() || '{}').message ?? `docker ${res.status}`);
}

export type LogLine = { t?: number; s: 'out' | 'err'; m: string };

/**
 * Desmultiplexa o stream de logs do Docker. Sem TTY, cada bloco vem com um cabeçalho de
 * 8 bytes (tipo do stream + tamanho); com TTY o corpo é texto puro.
 */
function lineSplitter(tty: boolean, onLines: (lines: LogLine[]) => void) {
  let frame = Buffer.alloc(0);
  const partial: Record<'out' | 'err', string> = { out: '', err: '' };
  const emitText = (s: 'out' | 'err', text: string, out: LogLine[]) => {
    const parts = (partial[s] + text).split('\n');
    partial[s] = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      const sp = line.indexOf(' ');
      const t = parseTime(line.slice(0, sp));
      out.push(t ? { t, s, m: line.slice(sp + 1) } : { s, m: line });
    }
  };
  return {
    push(chunk: Buffer) {
      const out: LogLine[] = [];
      if (tty) emitText('out', chunk.toString('utf8'), out);
      else {
        frame = Buffer.concat([frame, chunk]);
        while (frame.length >= 8) {
          const size = frame.readUInt32BE(4);
          if (frame.length < 8 + size) break;
          emitText(frame[0] === 2 ? 'err' : 'out', frame.subarray(8, 8 + size).toString('utf8'), out);
          frame = frame.subarray(8 + size);
        }
      }
      if (out.length) onLines(out);
    },
    flush() {
      const out: LogLine[] = [];
      for (const s of ['out', 'err'] as const) if (partial[s]) emitText(s, '\n', out);
      if (out.length) onLines(out);
    },
  };
}

/** Segue os logs de um container. Devolve a função que encerra o stream. */
export function followLogs(c: Container, tail: number, onLines: (l: LogLine[]) => void, onEnd: (err?: string) => void) {
  const splitter = lineSplitter(c.tty, onLines);
  const req = request(
    { socketPath: SOCKET, method: 'GET', path: `/containers/${c.id}/logs?follow=1&stdout=1&stderr=1&timestamps=1&tail=${tail}`, headers: { Host: 'docker' } },
    (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        onEnd(`docker respondeu ${res.statusCode}`);
        res.resume();
        return;
      }
      res.on('data', (c: Buffer) => splitter.push(c));
      res.on('end', () => {
        splitter.flush();
        onEnd();
      });
    },
  );
  req.on('error', (err) => onEnd(err.message));
  req.end();
  return () => req.destroy();
}

export async function recentLogs(c: Container, tail: number): Promise<LogLine[]> {
  const res = await call('GET', `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`);
  const lines: LogLine[] = [];
  const splitter = lineSplitter(c.tty, (l) => lines.push(...l));
  splitter.push(res.body);
  splitter.flush();
  return lines;
}
