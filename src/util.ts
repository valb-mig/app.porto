import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOME = homedir();
export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'porto');
export const STATE_DIR = join(process.env.XDG_STATE_HOME || join(HOME, '.local', 'state'), 'porto');
export const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'porto');

export type RunResult = { ok: boolean; stdout: string; stderr: string };

/** Roda um comando sem shell e com timeout; nunca lança, o chamador decide pelo `ok`. */
export function run(cmd: string, args: string[], timeoutMs = 5_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // LC_ALL=C: datas e mensagens das ferramentas em formato estável, independente do locale.
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') }),
    );
  });
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Memoiza uma função assíncrona por `ttlMs`. Chamadas simultâneas compartilham a mesma
 * promessa, então vários pollers do front não multiplicam o trabalho.
 */
export function cached<T>(ttlMs: number, fn: () => Promise<T>) {
  let value: T | undefined;
  let at = 0;
  let pending: Promise<T> | null = null;
  const get = (force = false): Promise<T> => {
    if (!force && value !== undefined && Date.now() - at < ttlMs) return Promise.resolve(value);
    pending ??= fn()
      .then((v) => {
        value = v;
        at = Date.now();
        return v;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return get;
}

/** Escrita atômica: grava num temporário e renomeia, pra nunca deixar JSON pela metade. */
export async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);
}

export const randomId = () => Math.random().toString(36).slice(2, 10);

/** Executa `fn` sobre os itens com no máximo `limit` em paralelo. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Dispara uma notificação no desktop (notify-send: dunst, mako, GNOME, KDE…). Falha em silêncio se não houver sessão gráfica. */
export function notify(title: string, body: string, urgency: 'low' | 'normal' | 'critical' = 'normal') {
  void run('notify-send', ['-a', 'Porto', '-u', urgency, title, body], 3_000);
}
