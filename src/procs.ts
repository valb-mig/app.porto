import { access, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { HOME, cached, run } from './util.ts';

export type Proc = {
  pid: number;
  ppid: number;
  uid: number;
  comm: string;
  /** Início do processo em ms (epoch). */
  start: number;
  /** utime + stime acumulados, em microssegundos. */
  cpuUsec: number;
  rss: number;
};

let clkTck = 100;
let pageSize = 4096;
let bootMs = 0;

export async function initProcs() {
  const [tck, page, statText] = await Promise.all([
    run('getconf', ['CLK_TCK']),
    run('getconf', ['PAGESIZE']),
    readFile('/proc/stat', 'utf8'),
  ]);
  clkTck = Number(tck.stdout.trim()) || 100;
  pageSize = Number(page.stdout.trim()) || 4096;
  bootMs = Number(/^btime (\d+)/m.exec(statText)?.[1] ?? 0) * 1000;
}

async function readProc(pid: number): Promise<Proc | null> {
  try {
    const [text, st] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), stat(`/proc/${pid}`)]);
    // O comm vem entre parênteses e pode ter espaços e parênteses: corta no último ')'.
    const close = text.lastIndexOf(')');
    const comm = text.slice(text.indexOf('(') + 1, close);
    const f = text.slice(close + 2).split(' ');
    return {
      pid,
      ppid: Number(f[1]),
      uid: st.uid,
      comm,
      start: bootMs + (Number(f[19]) / clkTck) * 1000,
      cpuUsec: ((Number(f[11]) + Number(f[12])) / clkTck) * 1e6,
      rss: Number(f[21]) * pageSize,
    };
  } catch {
    return null;
  }
}

/** Tabela de processos da máquina inteira, lida de /proc. */
export const processTable = cached(1_500, async () => {
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d)).map(Number);
  const table = new Map<number, Proc>();
  const procs = await Promise.all(pids.map(readProc));
  for (const p of procs) if (p) table.set(p.pid, p);
  return table;
});

export function descendants(table: Map<number, Proc>, root: number): Proc[] {
  const children = new Map<number, number[]>();
  for (const p of table.values()) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: Proc[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    const p = table.get(pid);
    if (p) out.push(p);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

export type ProcDetails = { cmdline: string[]; cwd?: string; exe?: string; cgroup?: string; stdout?: string; stderr?: string };

/** Detalhes que só dá pra ler de processos do próprio usuário (cwd, fds). */
export async function procDetails(pid: number): Promise<ProcDetails> {
  const safe = <T>(p: Promise<T>) => p.catch(() => undefined);
  const [cmd, cwd, exe, cgroup, stdout, stderr] = await Promise.all([
    safe(readFile(`/proc/${pid}/cmdline`, 'utf8')),
    safe(readlink(`/proc/${pid}/cwd`)),
    safe(readlink(`/proc/${pid}/exe`)),
    safe(readFile(`/proc/${pid}/cgroup`, 'utf8')),
    safe(readlink(`/proc/${pid}/fd/1`)),
    safe(readlink(`/proc/${pid}/fd/2`)),
  ]);
  return {
    cmdline: (cmd ?? '').split('\0').filter(Boolean),
    cwd,
    exe,
    cgroup: cgroup?.trim().split('\n').find((l) => l.startsWith('0::'))?.slice(3),
    stdout,
    stderr,
  };
}

const CODE_DIRS = new Set(['projects', 'projetos', 'src', 'repos', 'code', 'dev', 'workspace', 'git']);
const projectCache = new Map<string, string | null>();
const exists = (p: string) => access(p).then(() => true, () => false);

/**
 * Projeto de um diretório: a raiz git mais próxima dentro da home, ou a pasta de primeiro
 * nível numa pasta de código comum (~/Projects, ~/src, ~/code…). Diretórios fora da home não viram projeto.
 */
export async function projectOf(dir?: string): Promise<{ name: string; root: string } | null> {
  if (!dir || dir === HOME || !dir.startsWith(HOME + '/')) return null;
  if (projectCache.has(dir)) {
    const root = projectCache.get(dir);
    return root ? { name: root.split('/').pop()!, root } : null;
  }
  let root: string | null = null;
  for (let d = dir; d !== HOME && d.startsWith(HOME + '/'); d = dirname(d)) {
    if (await exists(join(d, '.git'))) {
      root = d;
      break;
    }
  }
  if (!root) {
    const parts = relative(HOME, dir).split('/');
    if (parts.length >= 2 && CODE_DIRS.has(parts[0]!.toLowerCase())) root = join(HOME, parts[0]!, parts[1]!);
  }
  projectCache.set(dir, root);
  return root ? { name: root.split('/').pop()!, root } : null;
}

const FRAMEWORKS: [RegExp, string][] = [
  [/\bnext-server\b|\bnext\b.*\b(dev|start)\b|next\/dist/, 'Next.js'],
  [/\bvite\b/, 'Vite'],
  [/\bastro\b/, 'Astro'],
  [/\bnuxt\b/, 'Nuxt'],
  [/svelte-kit/, 'SvelteKit'],
  [/\bremix\b/, 'Remix'],
  [/webpack/, 'Webpack'],
  [/storybook/, 'Storybook'],
  [/\bexpo\b|metro/, 'Expo'],
  [/artisan serve/, 'Laravel'],
  [/\bphp\b.*\s-S\s/, 'PHP'],
  [/http\.server/, 'http.server'],
  [/uvicorn|gunicorn|fastapi/, 'Python'],
  [/flask|manage\.py runserver|django/, 'Python'],
  [/\brails\b|\bpuma\b/, 'Rails'],
  [/\bhugo\b/, 'Hugo'],
  [/jekyll/, 'Jekyll'],
  [/\bdotnet\b|\.dll$/, '.NET'],
  [/\bbun\b/, 'Bun'],
  [/\bdeno\b/, 'Deno'],
  [/\bnode\b/, 'Node'],
];

export function frameworkOf(cmdline: string[], comm: string) {
  const text = `${comm} ${cmdline.join(' ')}`;
  return FRAMEWORKS.find(([re]) => re.test(text))?.[1];
}

/** Nome amigável pros clientes mais comuns que aparecem nas conexões locais. */
export function prettyProcess(comm: string) {
  const map: Record<string, string> = {
    'zen-bin': 'Zen',
    zen: 'Zen',
    firefox: 'Firefox',
    'firefox-bin': 'Firefox',
    chromium: 'Chromium',
    chrome: 'Chrome',
    brave: 'Brave',
    'node-MainThread': 'node',
    'MainThread': 'node',
  };
  return map[comm] ?? comm;
}
