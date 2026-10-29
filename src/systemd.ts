import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogLine } from './docker.ts';
import { HOME, run } from './util.ts';

export type Unit = {
  id: string;
  name: string;
  user: boolean;
  description: string;
  active: string;
  sub: string;
  type: string;
  mainPid: number;
  cgroup: string;
  workingDir: string;
  startedAt?: number;
  /** Unit escrita pelo usuário em ~/.config/systemd/user (e não instalada por pacote). */
  own: boolean;
};

const PROPS = 'Id,Description,LoadState,ActiveState,SubState,Type,MainPID,ControlGroup,WorkingDirectory,ActiveEnterTimestamp';
const USER_UNIT_DIR = join(HOME, '.config', 'systemd', 'user');

export async function ownUnitNames(): Promise<string[]> {
  try {
    return (await readdir(USER_UNIT_DIR)).filter((f) => f.endsWith('.service') && !f.includes('@'));
  } catch {
    return [];
  }
}

/** Lê várias units de uma vez com `systemctl show`; units inexistentes ficam de fora. */
export async function showUnits(names: string[], user: boolean, own = new Set<string>()): Promise<Unit[]> {
  if (!names.length) return [];
  const args = [...(user ? ['--user'] : []), 'show', '--timestamp=unix', '-p', PROPS, '--', ...names];
  const res = await run('systemctl', args);
  const units: Unit[] = [];
  for (const block of res.stdout.split('\n\n')) {
    const p: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) p[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!p.Id || p.LoadState !== 'loaded') continue;
    const ts = /^@(\d+)/.exec(p.ActiveEnterTimestamp ?? '')?.[1];
    units.push({
      id: p.Id,
      name: p.Id.replace(/\.service$/, ''),
      user,
      description: p.Description ?? '',
      active: p.ActiveState ?? 'unknown',
      sub: p.SubState ?? '',
      type: p.Type ?? '',
      mainPid: Number(p.MainPID ?? 0),
      cgroup: p.ControlGroup ?? '',
      workingDir: (p.WorkingDirectory ?? '').replace(/^~/, HOME),
      startedAt: ts ? Number(ts) * 1000 : undefined,
      own: own.has(p.Id),
    });
  }
  return units;
}

export async function unitAction(unit: Unit, action: 'start' | 'stop' | 'restart') {
  if (!unit.user) throw new Error('Units do sistema precisam de sudo; controle pelo terminal.');
  const res = await run('systemctl', ['--user', action, '--', unit.id], 30_000);
  if (!res.ok) throw new Error(res.stderr.trim() || `systemctl ${action} falhou`);
}

type JournalEntry = { MESSAGE?: string | number[] | null; PRIORITY?: string; __REALTIME_TIMESTAMP?: string };

/** O journal manda a mensagem como array de bytes quando ela tem caracteres de controle (cores ANSI). */
function toLine(raw: string): LogLine | null {
  try {
    const e = JSON.parse(raw) as JournalEntry;
    const m = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString('utf8') : String(e.MESSAGE ?? '');
    const prio = Number(e.PRIORITY ?? 6);
    return { t: e.__REALTIME_TIMESTAMP ? Number(e.__REALTIME_TIMESTAMP) / 1000 : undefined, s: prio <= 3 ? 'err' : 'out', m };
  } catch {
    return null;
  }
}

function journalArgs(unit: Unit, tail: number, follow: boolean) {
  return [...(unit.user ? ['--user'] : []), '-u', unit.id, '-n', String(tail), '-o', 'json', '--output-fields=MESSAGE,PRIORITY', ...(follow ? ['-f'] : []), '--no-pager'];
}

export function followJournal(unit: Unit, tail: number, onLines: (l: LogLine[]) => void, onEnd: (err?: string) => void) {
  const child = spawn('journalctl', journalArgs(unit, tail, true), { stdio: ['ignore', 'pipe', 'pipe'] });
  let partial = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const parts = (partial + chunk.toString('utf8')).split('\n');
    partial = parts.pop() ?? '';
    const lines = parts.map(toLine).filter((l): l is LogLine => l !== null);
    if (lines.length) onLines(lines);
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  child.on('close', () => onEnd(stderr.trim() || undefined));
  child.on('error', (err) => onEnd(err.message));
  return () => child.kill();
}

export async function recentJournal(unit: Unit, tail: number): Promise<LogLine[]> {
  const res = await run('journalctl', journalArgs(unit, tail, false), 10_000);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map(toLine)
    .filter((l): l is LogLine => l !== null);
}
