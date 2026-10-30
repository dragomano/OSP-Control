import { describe, expect, it } from 'vitest';
import { sourceError, sourceLines } from '../src/moduleUpdateSources';

describe('module source validation', () => {
  it('retains user priority while trimming empty lines', () => {
    expect(sourceLines(' https://second.example/ \n\nhttps://first.example/\r\n')).toEqual([
      'https://second.example/',
      'https://first.example/',
    ]);
    expect(sourceError('')).toBeNull();
  });
  it('rejects equivalent duplicates, credentials, invalid schemes and unsupported ports', () => {
    expect(sourceError('https://example.org\nhttps://example.org/')).toEqual({
      key: 'settings.sourcesDuplicate',
      line: 2,
    });
    for (const value of [
      'file:///x',
      'http://example.org/',
      'https://user:secret@example.org/',
      'https://example.org:444/',
      'https://example.org/#part',
      'https://example.org/a b',
    ]) {
      expect(sourceError(value)?.key).toBe('settings.sourcesInvalidUrl');
    }
    expect(
      sourceError(Array.from({ length: 33 }, (_, i) => `https://example.org/${i}`).join('\n'))?.key,
    ).toBe('settings.sourcesTooMany');
  });
});
