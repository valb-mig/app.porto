import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR, randomId, writeJson } from './util.ts';

export type Shortcut = { id: string; title: string; url: string };
export type ShortcutGroup = { id: string; title: string; items: Shortcut[] };
export type SiteCheck = { id: string; title: string; url: string; intervalSec: number; notify: boolean };

/** Ajustes por serviço descoberto, indexados pela chave estável do serviço. */
export type ServiceOverride = {
  name?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Arquivo de log pra processos soltos que não escrevem no journal nem no Docker. */
  logFile?: string;
  /** Força a leitura dos logs como access log (nginx/apache) na aba Acessos. */
  accessLog?: boolean;
};

export type Settings = {
  /** `%s` é substituído pela busca. */
  searchUrl: string;
  /** Avisar no desktop quando um serviço fixado parar ou voltar. */
  notifyPinned: boolean;
};

export type Config = {
  host: string;
  port: number;
  /** Hostnames extras aceitos no header Host (ex.: o nome MagicDNS, se expor pela tailnet). */
  allowedHosts: string[];
  /** Portas que o Porto nunca deve sondar com GET / (servidores que não toleram conexões de teste). */
  noProbePorts: number[];
  settings: Settings;
  groups: ShortcutGroup[];
  sites: SiteCheck[];
  services: Record<string, ServiceOverride>;
};

export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const item = (title: string, url: string): Shortcut => ({ id: randomId(), title, url });

function defaults(): Config {
  return {
    host: '127.0.0.1',
    port: 7777,
    allowedHosts: [],
    noProbePorts: [],
    settings: { searchUrl: 'https://duckduckgo.com/?q=%s', notifyPinned: true },
    groups: [
      {
        id: randomId(),
        title: 'Dia a dia',
        items: [item('GitHub', 'https://github.com'), item('Gmail', 'https://mail.google.com'), item('Claude', 'https://claude.ai')],
      },
      {
        id: randomId(),
        title: 'Infra',
        items: [
          item('Tailscale', 'https://login.tailscale.com/admin/machines'),
          item('Cloudflare', 'https://dash.cloudflare.com'),
          item('Docker Hub', 'https://hub.docker.com'),
        ],
      },
    ],
    sites: [],
    services: {},
  };
}

let current: Config;

export async function loadConfig(): Promise<Config> {
  const base = defaults();
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as Partial<Config>;
    current = { ...base, ...raw, settings: { ...base.settings, ...raw.settings } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`config inválida em ${CONFIG_PATH}: ${String(err)}`);
    current = base;
    await writeJson(CONFIG_PATH, current);
  }
  return current;
}

export const config = () => current;

export async function updateConfig(patch: (c: Config) => void) {
  patch(current);
  await writeJson(CONFIG_PATH, current);
  return current;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function isHttpUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Valida e normaliza os grupos vindos do front; descarta o que não tiver título ou URL válida. */
export function sanitizeGroups(input: unknown): ShortcutGroup[] {
  if (!Array.isArray(input)) throw new Error('groups deve ser uma lista');
  return input.slice(0, 50).map((g: Record<string, unknown>) => ({
    id: str(g.id, 40) || randomId(),
    title: str(g.title, 80) || 'Sem nome',
    items: (Array.isArray(g.items) ? g.items : [])
      .slice(0, 200)
      .map((i: Record<string, unknown>) => ({ id: str(i.id, 40) || randomId(), title: str(i.title, 80), url: str(i.url, 2000) }))
      .filter((i) => i.title && isHttpUrl(i.url)),
  }));
}

export function sanitizeSites(input: unknown): SiteCheck[] {
  if (!Array.isArray(input)) throw new Error('sites deve ser uma lista');
  return input
    .slice(0, 100)
    .map((s: Record<string, unknown>) => ({
      id: str(s.id, 40) || randomId(),
      title: str(s.title, 80),
      url: str(s.url, 2000),
      intervalSec: Math.min(3600, Math.max(30, Number(s.intervalSec) || 120)),
      notify: s.notify !== false,
    }))
    .filter((s) => isHttpUrl(s.url))
    .map((s) => ({ ...s, title: s.title || new URL(s.url).host }));
}

export function sanitizeOverride(input: Record<string, unknown>): ServiceOverride {
  const o: ServiceOverride = {};
  if ('name' in input) o.name = str(input.name, 80) || undefined;
  if ('pinned' in input) o.pinned = Boolean(input.pinned);
  if ('hidden' in input) o.hidden = Boolean(input.hidden);
  if ('logFile' in input) o.logFile = str(input.logFile, 1000) || undefined;
  if ('accessLog' in input) o.accessLog = Boolean(input.accessLog);
  return o;
}
