import catalog from '../src-tauri/resources/project-templates.json';

export type ProjectTemplateId = string;
export type StarterText = string | Record<string, string>;
export type StarterManifest = {
  schemaVersion: number;
  id: string;
  order?: number;
  name: StarterText;
  description: StarterText;
  nextStep: StarterText;
  httpPreference: string;
  php: boolean;
  node: boolean;
  readmePath: string | null;
  database: {
    enabled: boolean;
    engines: string[];
    defaultEngine: string;
    // Starter-owned hints; the core falls back to neutral wording.
    sqliteHint?: StarterText;
    missing?: StarterText;
  };
  projectRoot: string;
  webRoot: string | null;
  settings: Record<string, string>;
  directories: string[];
  // Starter-owned texts for __KEY__ tokens in the package files (JSON-suffixed keys become JSON string literals).
  messages: Record<string, StarterText>;
  // Optional toast after a project is created from this starter; {domain} is substituted.
  createdMessage?: StarterText;
  // Manifest-driven one-click installer; absent means the starter has no button.
  install?: StarterInstall;
};
export type ProjectStarterDocument = {
  manifest: StarterManifest;
  assets: Record<string, string>;
  revision: string | null;
  builtin: boolean;
};
// The optional one-click installer declared by the starter author: texts, phases
// and engine commands all come from the package, the core stays generic.
export type StarterInstall = {
  title: StarterText;
  pending: StarterText;
  button: StarterText;
  hint: StarterText;
  unsaved: StarterText;
  done: StarterText;
  log: StarterText;
  backup: StarterText;
  phases: Record<string, StarterText>;
  createProject: string;
  archive?: {
    release?: { url: string; path: string[] };
    url: string;
    checksumUrl?: string;
    maxArchiveBytes: number;
    extract: { fromDir: string; to: string; requiredFiles: string[] };
  };
  scripts: boolean;
  then: string[][];
  payload: { composerName?: string; files: string[] };
  envSource?: string;
  env: Record<string, string>;
  envSqlite: Record<string, string>;
  envServer: Record<string, string>;
  sqliteDir?: string;
  sqliteFallback: boolean;
  keep: string[];
  console: string[][];
  consoleWithDb: string[][];
  randomHex: Record<string, number>;
  configFiles: { template: string; to: string }[];
};
export type StarterEntry = { id: string; document: ProjectStarterDocument | null; error: unknown };
export type ProjectTemplate = {
  id: string;
  php: boolean;
  node: boolean;
  projectRoot: string;
  webRoot: string | null;
  directories: string[];
  files: { path: string; source: string }[];
  settings: Record<string, string>;
  starter?: ProjectStarterDocument;
};
const manifests = import.meta.glob<StarterManifest>('../src-tauri/resources/starters/*/starter.json', {
  eager: true,
  import: 'default',
});
const assets = import.meta.glob<string>('../src-tauri/resources/starters/**/*', {
  eager: true,
  query: '?raw',
  import: 'default',
});
// Starter manifests omit empty collections (Rust fills them with defaults on read);
// documents built straight from JSON need the same shape for the editor and installers.
const withInstallDefaults = (install: StarterInstall): StarterInstall => ({
  ...install,
  phases: install.phases ?? {},
  // biome-ignore lint/suspicious/noThenProperty: the Composer step list is named "then" by the starter manifest
  then: install.then ?? [],
  payload: install.payload ?? { files: [] },
  env: install.env ?? {},
  envSqlite: install.envSqlite ?? {},
  envServer: install.envServer ?? {},
  keep: install.keep ?? [],
  console: install.console ?? [],
  consoleWithDb: install.consoleWithDb ?? [],
  randomHex: install.randomHex ?? {},
  configFiles: install.configFiles ?? [],
});
export const DEFAULT_STARTERS: ProjectStarterDocument[] = Object.values(manifests)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map((manifest) => {
    const prefix = `../src-tauri/resources/starters/${manifest.id}/`;
    return {
      manifest: { ...manifest, install: manifest.install && withInstallDefaults(manifest.install) },
      assets: Object.fromEntries(
        Object.entries(assets)
          .filter(([path]) => path.startsWith(prefix) && !path.endsWith('/starter.json'))
          .map(([path, value]) => [path.slice(prefix.length), value]),
      ),
      revision: null,
      builtin: false,
    };
  });
export function starterTemplate(starter: ProjectStarterDocument): ProjectTemplate {
  const m = starter.manifest;
  return {
    ...m,
    starter,
    files: [
      { path: '.osp/project.ini', source: 'ini' },
      ...Object.keys(starter.assets)
        .filter((path) => path.startsWith('files/'))
        .map((path) => ({ path: path.slice(6), source: path })),
      ...['nginx', 'apache', 'caddy']
        .filter((engine) => `${engine}.conf` in starter.assets)
        .map((engine) => ({ path: `.osp/${engine}/{domain}.conf`, source: `${engine}.conf` })),
      ...(m.install ? [{ path: `.osp/${m.id}.json`, source: 'marker' }] : []),
    ],
  };
}
export const BUILTIN_TEMPLATES = catalog as ProjectTemplate[];
export const PROJECT_TEMPLATES = [...BUILTIN_TEMPLATES, ...DEFAULT_STARTERS.map(starterTemplate)];
export function starterText(value: StarterText | undefined, lang: string): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[lang] || value[lang.split(/[-_]/)[0]] || value.en || Object.values(value).find(Boolean) || '';
}
export function projectTemplate(id: string): ProjectTemplate {
  return PROJECT_TEMPLATES.find((template) => template.id === id) ?? PROJECT_TEMPLATES[0];
}
export function preferredTemplateEngine(options: string[], global = ''): string {
  if (options.includes(global)) return global;
  const numbers = (name: string) => (name.match(/\d+/g) ?? []).map(Number);
  return (
    [...options]
      .sort((a, b) => {
        const left = numbers(a),
          right = numbers(b);
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
          const difference = (left[index] ?? 0) - (right[index] ?? 0);
          if (difference) return difference;
        }
        return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
      })
      .pop() ?? ''
  );
}
export function preferredTemplateHttpEngine(
  template: string | ProjectTemplate,
  options: string[],
  global = '',
): string {
  const m = typeof template === 'string' ? projectTemplate(template) : template;
  const preference = m.starter?.manifest.httpPreference ?? 'any';
  const preferred = options.filter((engine) => engine.toLowerCase().startsWith(preference));
  return preferredTemplateEngine(preferred.length ? preferred : options, global);
}
