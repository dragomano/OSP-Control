import defaults from './moduleUpdateSources.defaults.json';
import { settingsStorage } from './settingsStorage';

export const MODULE_SOURCES_KEY = 'ospanel.moduleUpdateSources';
export const MODULE_FAMILIES = ['php', 'apache', 'nginx', 'caddy'] as const;
export type ModuleFamily = (typeof MODULE_FAMILIES)[number];
export type ModuleSources = Record<ModuleFamily, string[]>;
export const MODULE_LABELS: Record<ModuleFamily, string> = {
  php: 'PHP',
  apache: 'Apache',
  nginx: 'Nginx',
  caddy: 'Caddy',
};

export function sourceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function sourceError(text: string): { key: string; line: number } | null {
  const seen = new Set<string>();
  const entries = text.split(/\r?\n/);
  if (sourceLines(text).length > 32) return { key: 'settings.sourcesTooMany', line: 1 };
  for (const [index, raw] of entries.entries()) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (
        value.length > 2048 ||
        Array.from(value).some(
          (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\',
        ) ||
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.port ||
        url.hash
      )
        return { key: 'settings.sourcesInvalidUrl', line: index + 1 };
      if (seen.has(url.href)) return { key: 'settings.sourcesDuplicate', line: index + 1 };
      seen.add(url.href);
    } catch {
      return { key: 'settings.sourcesInvalidUrl', line: index + 1 };
    }
  }
  return null;
}

export function readModuleSources(): ModuleSources {
  let saved: Partial<ModuleSources> = {};
  try {
    saved = JSON.parse(settingsStorage.getItem(MODULE_SOURCES_KEY) ?? '{}') ?? {};
  } catch {
    /* Native storage reports malformed settings separately. */
  }
  return Object.fromEntries(
    MODULE_FAMILIES.map((family) => {
      const value = saved[family];
      return [
        family,
        Array.isArray(value) &&
        value.every((url) => typeof url === 'string') &&
        !sourceError(value.join('\n'))
          ? value
          : [...defaults[family]],
      ];
    }),
  ) as ModuleSources;
}

export function sourceSummary(sources: string[]): string {
  if (!sources.length) return '';
  const url = new URL(sources[0]);
  return url.hostname === 'github.com'
    ? url.hostname + url.pathname.replace(/\/releases\/?$/, '')
    : url.hostname;
}
