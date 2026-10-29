import { spawn } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import { followLogs, recentLogs, type LogLine } from './docker.ts';
import { handleOf, type Service } from './services.ts';
import { followJournal, recentJournal } from './systemd.ts';
import { run } from './util.ts';

export type LogSource =
  | {
      ok: true;
      label: string;
      follow: (tail: number, onLines: (l: LogLine[]) => void, onEnd: (err?: string) => void) => () => void;
      recent: (tail: number) => Promise<LogLine[]>;
    }
  | { ok: false; reason: string };

function fileSource(path: string): LogSource {
  return {
    ok: true,
    label: `arquivo ${path}`,
    follow(tail, onLines, onEnd) {
      const child = spawn('tail', ['-n', String(tail), '-F', path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let partial = '';
      child.stdout.on('data', (c: Buffer) => {
        const parts = (partial + c.toString('utf8')).split('\n');
        partial = parts.pop() ?? '';
        if (parts.length) onLines(parts.map((m) => ({ s: 'out', m })));
      });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('close', () => onEnd(stderr.trim() || undefined));
      child.on('error', (err) => onEnd(err.message));
      return () => child.kill();
    },
    async recent(tail) {
      const res = await run('tail', ['-n', String(tail), path]);
      return res.stdout.split('\n').filter(Boolean).map((m) => ({ s: 'out' as const, m }));
    },
  };
}

export function logSourceOf(svc: Service): LogSource {
  const h = handleOf(svc.key);
  if (h?.container) {
    const c = h.container;
    return { ok: true, label: `docker logs ${c.name}`, follow: (t, l, e) => followLogs(c, t, l, e), recent: (t) => recentLogs(c, t) };
  }
  if (h?.unit) {
    const u = h.unit;
    return { ok: true, label: `journalctl ${u.user ? '--user ' : ''}-u ${u.id}`, follow: (t, l, e) => followJournal(u, t, l, e), recent: (t) => recentJournal(u, t) };
  }
  if (h?.logFile) return fileSource(h.logFile);
  return { ok: false, reason: svc.logHint ?? 'Esse serviço não tem uma fonte de logs conhecida.' };
}

/** Transmite os logs por SSE, agrupando as linhas em lotes pra não inundar o navegador. */
export function streamLogs(svc: Service, tail: number, res: ServerResponse, onClose: (fn: () => void) => void) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const src = logSourceOf(svc);
  if (!src.ok) {
    send('unavailable', { reason: src.reason });
    res.end();
    return;
  }
  send('source', { label: src.label });
  let batch: LogLine[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (batch.length) send('lines', batch);
    batch = [];
  };
  const stop = src.follow(
    tail,
    (lines) => {
      batch.push(...lines);
      timer ??= setTimeout(flush, 120);
    },
    (err) => {
      flush();
      send('end', { error: err });
      res.end();
    },
  );
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  onClose(() => {
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    stop();
  });
}
