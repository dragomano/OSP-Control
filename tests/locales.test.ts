import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_LANG, EMBEDDED_LANGS, LANG_NAMES, requiredPluralSuffixes } from '../src/i18n';

// Every check below runs over all *.json files discovered in resources/locales at
// run time: a newly added locale joins the parity gate automatically, with no test
// edits and no chance to forget a dictionary in a static import list.
function localesDir(): string {
  try {
    return fileURLToPath(new URL('../src-tauri/resources/locales/', import.meta.url));
  } catch {
    // In the jsdom environment import.meta.url is the jsdom origin, not a file path —
    // fall back to the project root, from where every package script runs vitest.
    return join(process.cwd(), 'src-tauri', 'resources', 'locales');
  }
}

const LOCALES_DIR = localesDir();

const dictFiles = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort();

// Raw file texts back the duplicate-key scan; dicts holds the parsed dictionaries.
const dictTexts: Record<string, string> = {};
const dicts: Record<string, Record<string, string>> = {};
for (const name of dictFiles) {
  const text = readFileSync(join(LOCALES_DIR, name), 'utf8');
  // An editor-saved UTF-8 BOM would break JSON.parse.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${name}: unreadable or malformed locale file (${String(error)})`);
  }
  const code = name.slice(0, -'.json'.length);
  dictTexts[code] = json;
  dicts[code] = parsed as Record<string, string>;
}

// en is the parity base: every other dictionary is checked against it.
const base = dicts[BASE_LANG];
if (!base) throw new Error(`locales/${BASE_LANG}.json is missing — it is the parity base dictionary`);

// {var} placeholders in translations are substituted via makeTranslator;
// a name mismatch between languages silently renders a literal "{var}" in the UI.
const vars = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('dictionary parity across all locale files', () => {
  it('every file is a flat object of non-empty strings', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      expect(
        typeof dict === 'object' && dict !== null && !Array.isArray(dict),
        `${name}: not a JSON object`,
      ).toBe(true);
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${name}: ${key} is not a string`).toBe('string');
        expect(value.trim().length > 0, `${name}: ${key} has an empty value`).toBe(true);
      }
    }
  });

  // JSON.parse silently keeps the last of duplicate keys, so a stray copy would rot
  // unnoticed: one translation alive, the other dead weight (this happened with
  // err.invalidModuleName). The scan is textual — a parse cannot see duplicates.
  it('no file declares the same key twice', () => {
    for (const [name, text] of Object.entries(dictTexts)) {
      const counts = new Map<string, number>();
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*"((?:[^"\\]|\\.)+)"\s*:/.exec(line);
        if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      expect(duplicates, `${name}: duplicate keys`).toEqual([]);
    }
  });

  it('key sets match the base dictionary', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      if (name === BASE_LANG) continue;
      expect(Object.keys(dict).sort(), `keys of ${name}`).toEqual(Object.keys(base).sort());
    }
  });

  it('{var} placeholders match the base dictionary', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      if (name === BASE_LANG) continue;
      for (const key of Object.keys(dict)) {
        expect(vars(dict[key]), `${name}: placeholders of ${key}`).toEqual(vars(base[key]));
      }
    }
  });

  // plural() looks up forms via CLDR suffixes (.one/.few/.many/.other): a missing form
  // in any dictionary silently falls back to another form or the raw key. The required
  // set is the language's own CLDR categories — German lives on one/other, Russian
  // needs one/few/many/other — the same rule the app applies to user locale files.
  it('a plural family has every CLDR category of its language', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      const required = requiredPluralSuffixes(name);
      const pluralBases = Object.keys(dict)
        .filter((key) => key.endsWith('.one'))
        .map((key) => key.slice(0, -'.one'.length));
      expect(pluralBases.length, `${name}: no plural keys found`).toBeGreaterThan(0);
      for (const pluralBase of pluralBases) {
        for (const suffix of required) {
          expect(dict[`${pluralBase}.${suffix}`], `${name}: ${pluralBase}.${suffix}`).toBeTruthy();
        }
        // Forms of one base must substitute the same placeholders.
        const placeholders = vars(dict[`${pluralBase}.one`]);
        for (const suffix of required.filter((suffix) => suffix !== 'one')) {
          expect(vars(dict[`${pluralBase}.${suffix}`]), `${name}: ${pluralBase}.${suffix}`).toEqual(
            placeholders,
          );
        }
      }
    }
  });

  // The shared key set is the union of the shipped languages' needs, so every
  // dictionary carries forms of categories its language never selects. Those must be
  // verbatim copies of .other: real text there reads as a second opinion and rots out
  // of sync on later edits — and the runtime never renders such a form anyway.
  it('plural forms of categories the language does not use copy .other verbatim', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      const required = new Set(requiredPluralSuffixes(name));
      const families = new Map<string, Set<string>>();
      for (const key of Object.keys(dict)) {
        const match = /^(.+)\.(zero|one|two|few|many|other)$/.exec(key);
        if (!match) continue;
        const present = families.get(match[1]);
        if (present) present.add(match[2]);
        else families.set(match[1], new Set([match[2]]));
      }
      for (const [base, present] of families) {
        if (present.size < 2) continue;
        for (const suffix of present) {
          if (required.has(suffix)) continue;
          expect(dict[`${base}.${suffix}`], `${name}: ${base}.${suffix}`).toBe(dict[`${base}.other`]);
        }
      }
    }
  });

  // Every dictionary defines its own code (lang.code) and native name (lang.name).
  // No other keys in the lang.* namespace are allowed.
  it('every dictionary declares valid lang.code and lang.name', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      expect(dict['lang.code'], `${name}: lang.code`).toBe(name);
      expect(typeof dict['lang.name'], `${name}: lang.name type`).toBe('string');
      expect((dict['lang.name'] ?? '').trim().length, `${name}: lang.name not empty`).toBeGreaterThan(0);
      const otherLangKeys = Object.keys(dict).filter(
        (key) => key.startsWith('lang.') && key !== 'lang.code' && key !== 'lang.name',
      );
      expect(otherLangKeys, `${name}: unexpected lang.* keys`).toEqual([]);
    }
  });

  // The embedded set in i18n.ts must mirror the directory exactly: a file without
  // an import never reaches the startup language choice, an import without a file
  // does not even compile.
  it('EMBEDDED_LANGS embeds exactly the shipped locale files', () => {
    expect([...EMBEDDED_LANGS].sort(), 'i18n.ts must embed every *.json from resources/locales').toEqual(
      Object.keys(dicts),
    );
  });

  it('LANG_NAMES covers every locale with unique native names', () => {
    for (const code of Object.keys(dicts)) {
      expect(LANG_NAMES[code], `name of ${code}`).toBeTruthy();
    }
    const names = Object.values(LANG_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });
});
