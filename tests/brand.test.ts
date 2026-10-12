import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../src/brand';
import { EMBEDDED_LANGS, embeddedDict } from '../src/i18n';

const productName = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')) as {
    productName: string;
  }
).productName;

describe('brand', () => {
  it('comes from productName in tauri.conf.json, not from a hardcoded literal', () => {
    expect(APP_NAME.length).toBeGreaterThan(0);
    expect(APP_NAME).toBe(productName);
  });

  it('leaves no brand.* keys in the dictionaries — the product name is not translated', () => {
    for (const lang of EMBEDDED_LANGS) {
      const branded = Object.keys(embeddedDict(lang)).filter((key) => key.startsWith('brand.'));
      expect(branded, lang).toEqual([]);
    }
  });
});
