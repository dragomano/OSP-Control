export type HostsDocument = {
  path: string;
  content: string;
  revision: string;
  encoding: string;
};

export type HostsSaveResult = {
  document: HostsDocument;
  backupPath: string | null;
  dnsFlushed: boolean;
};

export type HostsEntry = {
  line: number;
  ip: string;
  hosts: string;
  comment: string;
  active: boolean;
  managed: boolean;
};

export type HostsIssue = { code: string; params: Record<string, string> };

export function validHostsIp(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => +part <= 255 && (part === '0' || !part.startsWith('0')));
  }
  if (!value.includes(':') || value.includes('%') || value.includes('[') || value.includes(']')) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

export function validHostsName(value: string): boolean {
  return (
    value.length <= 253 &&
    value
      .replace(/\.$/, '')
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(label))
  );
}

const marker = (line: string) => line.trim().toUpperCase();
const START = '# OPEN SERVER PANEL: START OF THE LIST';
const END = '# OPEN SERVER PANEL: END OF THE LIST';

export function parseHosts(content: string) {
  const entries: HostsEntry[] = [];
  const errors: HostsIssue[] = [];
  const warnings: HostsIssue[] = [];
  let managed = false;
  const names = new Map<string, { ip: string; line: number }>();
  const issue = (code: string, line: number, params: Record<string, string> = {}): HostsIssue => ({
    code,
    params: { line: String(line + 1), ...params },
  });
  if (Array.from(content).some((char) => char.charCodeAt(0) < 32 && !'\n\r\t'.includes(char))) {
    errors.push(issue('err.hostsControl', 0));
  }
  content.split('\n').forEach((raw, line) => {
    if (marker(raw) === START || marker(raw) === END) {
      const start = marker(raw) === START;
      if (start === managed) errors.push(issue('err.hostsMarkers', line));
      managed = start;
      return;
    }
    let value = raw.trim();
    if (!value) return;
    const active = !value.startsWith('#');
    if (!active) {
      value = value.slice(1).trim();
      // Commented prose and artwork remain comments; only actual mappings become rows.
      if (!validHostsIp(value.split(/\s+/)[0])) return;
    }
    const hash = value.indexOf('#');
    const mapping = hash < 0 ? value : value.slice(0, hash);
    const [ip, ...hosts] = mapping.trim().split(/\s+/);
    const entry = {
      line,
      ip,
      hosts: hosts.join(' '),
      comment: hash < 0 ? '' : value.slice(hash + 1).trim(),
      active,
      managed,
    };
    entries.push(entry);
    if (!validHostsIp(ip)) errors.push(issue('err.hostsIp', line));
    if (!hosts.length || hosts.some((name) => !validHostsName(name)))
      errors.push(issue('err.hostsName', line));
    if (!active) return;
    const rowNames = new Set<string>();
    for (const host of hosts) {
      const normalized = host.toLowerCase().replace(/\.$/, '');
      const key = `${ip.includes(':') ? 6 : 4}:${normalized}`;
      const previous = names.get(key);
      if (rowNames.has(normalized)) errors.push(issue('err.hostsRepeatedName', line, { host }));
      else if (previous) {
        const canonical = (address: string) =>
          address.includes(':') && validHostsIp(address) ? new URL(`http://[${address}]/`).hostname : address;
        const code =
          canonical(previous.ip) === canonical(ip) ? 'err.hostsDuplicate' : 'err.hostsNameConflict';
        (code === 'err.hostsDuplicate' ? warnings : errors).push(
          issue(code, line, { host, ip: previous.ip }),
        );
      }
      rowNames.add(normalized);
      names.set(key, { ip, line });
    }
  });
  if (managed) errors.push(issue('err.hostsMarkers', content.split('\n').length - 1));
  return { entries, errors, warnings };
}

// Patch only the chosen line: switching views never regenerates the document.
export function changeHostsEntry(content: string, line: number, entry: Omit<HostsEntry, 'line' | 'managed'>) {
  const lines = content.split('\n');
  lines[line] =
    `${entry.active ? '' : '# '}${entry.ip.trim()}\t${entry.hosts.trim().replace(/\s+/g, ' ')}${entry.comment.trim() ? `\t# ${entry.comment.trim()}` : ''}`;
  return lines.join('\n');
}

export function toggleHostsEntry(content: string, entry: HostsEntry): string {
  const lines = content.split('\n');
  lines[entry.line] = entry.active
    ? lines[entry.line].replace(/^(\s*)/, '$1# ')
    : lines[entry.line].replace(/^(\s*)#\s?/, '$1');
  return lines.join('\n');
}

export function appendHostsBlock(content: string, block: string): string {
  return `${content}${!content || content.endsWith('\n') ? '' : '\n'}${block.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`;
}

export function hostsManagedBlocks(content: string): string {
  let managed = false;
  return content
    .split('\n')
    .filter((line) => {
      if (marker(line) === START) managed = true;
      const include = managed;
      if (marker(line) === END) managed = false;
      return include;
    })
    .join('\n');
}

export function hostsBlockHasMarkers(block: string): boolean {
  return block.split('\n').some((line) => marker(line) === START || marker(line) === END);
}
