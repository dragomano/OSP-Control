import { displayProjectDomain, normalizeProjectDomain } from './projectDomain';

export type ProjectWorkspace = { baseDir: string; content: string | null; files: string[] };
export type ProjectFileSave = { content: string; backupPath: string | null };
export type ProjectDomainSettings = { domain: string; values: Record<string, string> };

// INI comments start outside quotes, after whitespace; commands may contain literal # and ;.
export function iniValueEnd(value: string): number {
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') quote = quote === char ? '' : quote || char;
    if (!quote && (char === ';' || char === '#') && (i === 0 || /\s/.test(value[i - 1])))
      return value.slice(0, i).trimEnd().length;
  }
  return value.trimEnd().length;
}

export function projectDomains(content: string | null, fallback: string): ProjectDomainSettings[] {
  const domains: ProjectDomainSettings[] = [];
  let section: ProjectDomainSettings | undefined;
  for (const line of (content ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section = { domain: normalizeProjectDomain(header[1]) ?? header[1], values: {} };
      domains.push(section);
    } else if (section && !/^\s*[;#]/.test(line)) {
      const property = line.match(/^\s*([\w]+)\s*=(.*)$/);
      if (property)
        section.values[property[1].toLowerCase()] = property[2].slice(0, iniValueEnd(property[2])).trim();
    }
  }
  return domains.length ? domains : [{ domain: fallback, values: {} }];
}

// Edit only the selected section, preserving BOM, comments, alignment and unknown fields.
export function patchProjectIni(
  content: string | null,
  domain: string,
  patch: Record<string, string | null>,
): string {
  const newline = content?.includes('\r\n') ? '\r\n' : '\n';
  let next = content ?? `\uFEFF[${domain}]${newline}`;
  for (const [key, value] of Object.entries(patch)) {
    if (!/^\w+$/.test(key) || (value !== null && /[\r\n\0]/.test(value)))
      throw new Error('err.projectWorkspaceInvalid');
    const lines = next.split(newline);
    let start = lines.findIndex((line) => {
      const header = line.replace(/^\uFEFF/, '').match(/^\s*\[([^\]]+)\]/);
      return header && (normalizeProjectDomain(header[1]) ?? header[1]) === domain;
    });
    if (start < 0) {
      lines.push(`[${domain}]`);
      start = lines.length - 1;
    }
    let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
    if (end < 0) end = lines.length;
    const index = lines.findIndex(
      (line, index) => index > start && index < end && line.match(/^\s*(\w+)\s*=/)?.[1].toLowerCase() === key,
    );
    if (index >= 0) {
      const prefix = lines[index].slice(0, lines[index].indexOf('=') + 1);
      const rest = lines[index].slice(prefix.length);
      const length = iniValueEnd(rest);
      const suffix = rest.slice(length);
      const comment = /[;#]/.test(suffix) ? suffix : '';
      if (value === null) {
        if (comment) lines[index] = `${lines[index].match(/^\s*/)?.[0] ?? ''}${comment.trimStart()}`;
        else lines.splice(index, 1);
      } else lines[index] = `${prefix}${rest.match(/^\s*/)?.[0] || ' '}${value}${comment}`;
    } else if (value !== null) {
      let insertion = end;
      while (insertion > start + 1 && !lines[insertion - 1].trim()) insertion--;
      lines.splice(insertion, 0, `${key.padEnd(17)} = ${value}`);
    }
    next = lines.join(newline);
  }
  return next;
}

export function appendProjectDomain(content: string | null, current: string, input: string): string {
  const domain = normalizeProjectDomain(input);
  if (!domain || domain === 'auto' || domain === 'localhost') throw new Error('err.invalidDomain');
  const domains = projectDomains(content, current);
  if (domains.some((item) => item.domain === domain)) throw new Error('err.projectWorkspaceDuplicate');
  const newline = content?.includes('\r\n') ? '\r\n' : '\n';
  return `${content ?? `[${current}]${newline}`}${newline}[${domain}]${newline}primary_domain    = off${newline}`;
}

export function projectFileLanguage(file: string): string {
  const path = file.replace(/\\/g, '/').toLowerCase();
  if (path.startsWith('nginx/')) return 'Nginx';
  if (path.startsWith('apache/')) return 'Apache';
  if (path.startsWith('caddy/')) return 'Caddyfile';
  return 'INI';
}

export function projectOpeningUrl(
  domain: string,
  values: Record<string, string>,
  defaultTls: boolean,
): string {
  const tls = values.tls_enabled === 'on' || (values.tls_enabled !== 'off' && defaultTls);
  const scheme = tls ? 'https' : 'http';
  const port = values[tls ? 'https_port' : 'http_port'];
  const suffix = port && port !== 'auto' && port !== (tls ? '443' : '80') ? `:${port}` : '';
  const variables: Record<string, string> = {
    host: domain,
    host_decoded: displayProjectDomain(domain),
    host_scheme: scheme,
    scheme_port: suffix,
    http_port: values.http_port || '80',
    https_port: values.https_port || '443',
  };
  return (values.base_url || '{host_scheme}://{host}{scheme_port}').replace(
    /\{([a-z_]+)\}/g,
    (match, key: string) => variables[key] ?? match,
  );
}
