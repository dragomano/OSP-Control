import { describe, expect, it } from 'vitest';
import {
  appendHostsBlock,
  changeHostsEntry,
  hostsBlockHasMarkers,
  hostsManagedBlocks,
  parseHosts,
  toggleHostsEntry,
  validHostsIp,
} from '../src/hosts';

const source =
  '# Windows header\n\n# OPEN SERVER PANEL: START OF THE LIST\n# artwork\n127.0.1.32\tapp.test www.app.test\n# OPEN SERVER PANEL: END OF THE LIST\n\n# Custom entries\n  127.0.0.1   api.test   # Keep spacing\n# 127.0.0.2 old.test # Disabled\n';

describe('hosts document editing', () => {
  it('recognizes managed mappings and disabled entries without consuming comments', () => {
    const parsed = parseHosts(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({ managed: true, hosts: 'app.test www.app.test' });
    expect(parsed.entries[2]).toMatchObject({ active: false, comment: 'Disabled' });
  });

  it('patches only the chosen line and preserves prose, spacing and managed bytes elsewhere', () => {
    const entry = parseHosts(source).entries[1];
    const next = changeHostsEntry(source, entry.line, { ...entry, comment: 'Updated' });
    expect(hostsManagedBlocks(next)).toBe(hostsManagedBlocks(source));
    expect(next.split('\n').filter((_, line) => line !== entry.line)).toEqual(
      source.split('\n').filter((_, line) => line !== entry.line),
    );
    expect(next).toContain('api.test\t# Updated');
  });

  it('toggles a commented mapping without losing its comment or neighboring lines', () => {
    const entry = parseHosts(source).entries[1];
    const disabled = toggleHostsEntry(source, entry);
    expect(disabled).toContain('  # 127.0.0.1   api.test   # Keep spacing');
    expect(toggleHostsEntry(disabled, parseHosts(disabled).entries[1])).toBe(source);
  });

  it('appends a whole block outside OSPanel and keeps comments and disabled mappings', () => {
    const block = '# Group\r\n127.0.0.1 shop.test www.shop.test\r\n# 127.0.0.1 archive.test';
    const next = appendHostsBlock(source.trimEnd(), block);
    expect(next).toContain('# Group\n127.0.0.1 shop.test www.shop.test\n# 127.0.0.1 archive.test\n');
    expect(hostsManagedBlocks(next)).toBe(hostsManagedBlocks(source));
    expect(parseHosts(next).entries).toHaveLength(5);
    expect(hostsBlockHasMarkers(block)).toBe(false);
    expect(hostsBlockHasMarkers(source)).toBe(true);
  });

  it('detects address and hostname errors, repeated aliases and unbalanced markers', () => {
    for (const [text, code] of [
      ['999.0.0.1 broken.test', 'err.hostsIp'],
      ['127.0.0.1 -bad.test', 'err.hostsName'],
      ['127.0.0.1 a.test A.test', 'err.hostsRepeatedName'],
      ['# OPEN SERVER PANEL: START OF THE LIST', 'err.hostsMarkers'],
      ['#\0', 'err.hostsControl'],
    ])
      expect(parseHosts(text).errors.some((issue) => issue.code === code)).toBe(true);
  });

  it('distinguishes conflicting addresses from duplicate mappings and dual-stack entries', () => {
    expect(parseHosts('127.0.0.1 api.test\n127.0.0.2 API.TEST.').errors[0].code).toBe(
      'err.hostsNameConflict',
    );
    const duplicate = parseHosts('127.0.0.1 api.test\n127.0.0.1 api.test');
    expect(duplicate.errors).toHaveLength(0);
    expect(duplicate.warnings[0].code).toBe('err.hostsDuplicate');
    expect(parseHosts('127.0.0.1 api.test\n::1 api.test\n# 127.0.0.2 api.test').errors).toEqual([]);
    expect(parseHosts('::1 api.test\n0:0:0:0:0:0:0:1 api.test').errors).toEqual([]);
  });

  it('rejects URL syntax and IPv6 zones rather than accepting an address substring', () => {
    for (const invalid of ['127.0.0.01', '[::1]', '::1/path', 'fe80::1%12', '127.0.0.1:80'])
      expect(validHostsIp(invalid)).toBe(false);
    for (const valid of ['0.0.0.0', '127.0.0.1', '::1', '2001:db8::1'])
      expect(validHostsIp(valid)).toBe(true);
  });
});
