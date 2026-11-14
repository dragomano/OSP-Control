export function suggestedDatabaseName(domain: string): string {
  const name = domain.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `${/^[0-9]/.test(name) ? 'db_' : ''}${name}`.slice(0, 63);
}
export function validDatabaseName(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/i.test(name);
}

// Database families allowed per template; starters declare them in starter.json.
const FAMILY_PREFIXES: [string, string][] = [
  ['mysql', 'MySQL-'],
  ['mariadb', 'MariaDB-'],
  ['postgresql', 'PostgreSQL-'],
];

export function templateDatabaseFamilies(template: {
  id: string;
  starter?: { manifest: { database: { engines: string[] } } } | null;
}): string[] {
  return template.starter?.manifest.database.engines ?? [];
}

export function projectDatabaseEngines(
  template: { id: string; starter?: { manifest: { database: { engines: string[] } } } | null },
  engines: string[],
): string[] {
  const families = templateDatabaseFamilies(template);
  return engines.filter((engine) =>
    FAMILY_PREFIXES.some(([family, prefix]) => engine.startsWith(prefix) && families.includes(family)),
  );
}
