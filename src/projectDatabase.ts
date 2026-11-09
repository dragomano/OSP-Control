export function suggestedDatabaseName(domain: string): string {
  const name = domain.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `${/^[0-9]/.test(name) ? 'db_' : ''}${name}`.slice(0, 63);
}
export function validDatabaseName(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/i.test(name);
}
export function projectDatabaseEngines(template: string, engines: string[]): string[] {
  return engines.filter(
    (engine) => /^(MySQL|MariaDB)-/.test(engine) || (template === 'laravel' && /^PostgreSQL-/.test(engine)),
  );
}
