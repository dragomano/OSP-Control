import { toUnicode } from 'punycode/';

// Display names never replace the canonical domain used by paths, state keys or commands.
export function displayProjectDomain(domain: string): string {
  if (!/(^|\.)xn--/i.test(domain)) return domain;
  const canonical = normalizeProjectDomain(domain);
  if (!canonical) return domain;
  try {
    return toUnicode(canonical);
  } catch {
    return domain;
  }
}

// Match the backend's IDNA normalization and project directory restrictions.
export function normalizeProjectDomain(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  for (const char of value) {
    if (/\s/u.test(char) || (char.charCodeAt(0) < 128 && !/[a-z0-9._-]/i.test(char))) return null;
  }

  try {
    // A Unicode dot forces IDNA validation even for ASCII A-labels; the nonnumeric suffix
    // prevents URL parsing from interpreting a domain as an IPv4 address.
    const domain = new URL(`http://${value}\u3002invalid`).hostname.slice(0, -8);
    if (
      domain.length > 253 ||
      !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(domain)
    ) {
      return null;
    }
    return domain;
  } catch {
    return null;
  }
}
