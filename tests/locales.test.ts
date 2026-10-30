import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_LANG, EMBEDDED_LANGS, LANG_NAMES, type RawDict, requiredPluralSuffixes } from '../src/i18n';

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

// A dictionary file: plain keys with a string value and plural families with an
// object of CLDR forms — the shape of RawDict in src/i18n.ts.

// The CLDR plural categories, in the order the forms are listed inside a family.
const CLDR_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

// Raw file texts back the duplicate-key scan; dicts holds the parsed dictionaries.
const dictTexts: Record<string, string> = {};
const dicts: Record<string, RawDict> = {};
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
  dicts[code] = parsed as RawDict;
}

// en is the parity base: every other dictionary is checked against it.
const base = dicts[BASE_LANG];
if (!base) throw new Error(`locales/${BASE_LANG}.json is missing — it is the parity base dictionary`);

// The plain keys of a dictionary: everything that is not a plural family.
const plainKeys = (dict: RawDict): string[] =>
  Object.keys(dict).filter((key) => typeof dict[key] === 'string');

// The plural families of a dictionary: every key with an object value.
const families = (dict: RawDict): Record<string, Record<string, string>> =>
  Object.fromEntries(
    Object.entries(dict)
      .filter(([, value]) => typeof value !== 'string')
      .map(([key, value]) => [key, value as Record<string, string>]),
  );

// {var} placeholders in translations are substituted via makeTranslator;
// a name mismatch between languages silently renders a literal "{var}" in the UI.
const vars = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// The full path of every key in a JSON text: "family" for a top-level key and
// "family.form" for a form inside a plural family. The text is walked by hand,
// because a parse cannot see a duplicate key.
function keyPaths(text: string): string[] {
  const paths: string[] = [];
  const stack: string[] = [];
  let pending: string | null = null;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      let next = i;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === ':') {
        pending = JSON.parse(text.slice(start, i)) as string;
        paths.push([...stack.slice(1), pending].join('.'));
      }
      continue;
    }

    if (char === '{') {
      stack.push(pending ?? '');
      pending = null;
      i += 1;
      continue;
    }

    if (char === '}') {
      stack.pop();
      pending = null;
      i += 1;
      continue;
    }

    if (char === ',') {
      pending = null;
      i += 1;
      continue;
    }

    i += 1;
  }

  return paths;
}

describe('dictionary parity across all locale files', () => {
  it('every file is an object of non-empty strings and plural families', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      expect(
        typeof dict === 'object' && dict !== null && !Array.isArray(dict),
        `${name}: not a JSON object`,
      ).toBe(true);
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value === 'string') {
          expect(value.trim().length > 0, `${name}: ${key} has an empty value`).toBe(true);
          continue;
        }
        expect(
          typeof value === 'object' && value !== null && !Array.isArray(value),
          `${name}: ${key} is neither a string nor a plural family`,
        ).toBe(true);
        for (const [form, text] of Object.entries(value)) {
          expect(CLDR_FORMS, `${name}: ${form} of ${key} is not a CLDR category`).toContain(form);
          expect(typeof text, `${name}: ${key}.${form} is not a string`).toBe('string');
          expect(text.trim().length > 0, `${name}: ${key}.${form} has an empty value`).toBe(true);
        }
      }
    }
  });

  // JSON.parse silently keeps the last of duplicate keys, so a stray copy would rot
  // unnoticed: one translation alive, the other dead weight (this happened with
  // err.invalidModuleName). The scan is textual — a parse cannot see duplicates.
  // A key is unique inside its own object: the form names repeat in every family,
  // so it is the path — family and form — that is compared.
  it('no file declares the same key twice', () => {
    for (const [name, text] of Object.entries(dictTexts)) {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const path of keyPaths(text)) {
        if (seen.has(path)) duplicates.push(path);
        else seen.add(path);
      }
      expect(duplicates, `${name}: duplicate keys`).toEqual([]);
    }
  });

  // The base dictionary defines which keys exist: the plain keys and the plural
  // families of every other dictionary are the same, only the texts differ.
  it('plain keys match the base dictionary', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      if (name === BASE_LANG) continue;
      expect(plainKeys(dict).sort(), `plain keys of ${name}`).toEqual(plainKeys(base).sort());
    }
  });

  it('plural families match the base dictionary', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      if (name === BASE_LANG) continue;
      expect(Object.keys(families(dict)).sort(), `plural families of ${name}`).toEqual(
        Object.keys(families(base)).sort(),
      );
    }
  });

  // The dictionaries are edited by hand, so a new key usually lands at the end of
  // the file instead of next to its neighbours. The order itself is irrelevant to the
  // app, but a scattered order makes a side-by-side diff of two dictionaries unreadable
  // — so every file follows the order of the base dictionary, key by key.
  it('key order matches the base dictionary', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      if (name === BASE_LANG) continue;
      expect(Object.keys(dict), `key order of ${name}`).toEqual(Object.keys(base));
    }
  });

  it('{var} placeholders match the base dictionary', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      if (name === BASE_LANG) continue;
      for (const key of plainKeys(dict)) {
        expect(vars(dict[key] as string), `${name}: placeholders of ${key}`).toEqual(
          vars(base[key] as string),
        );
      }
      // A form is compared with the same form of the base family. A form the base
      // does not have — Russian has .few, English has not — is checked against the
      // other forms of its own family below.
      const baseFamilies = families(base);
      for (const [family, forms] of Object.entries(families(dict))) {
        for (const [form, text] of Object.entries(forms)) {
          const baseText = baseFamilies[family]?.[form];
          if (baseText === undefined) continue;
          expect(vars(text), `${name}: placeholders of ${family}.${form}`).toEqual(vars(baseText));
        }
      }
    }
  });

  // All forms of a family are the same sentence with a different number, so they
  // use the same placeholders — otherwise one form renders a literal "{var}".
  it('the forms of a family use the same placeholders', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      for (const [family, forms] of Object.entries(families(dict))) {
        const expected = vars(Object.values(forms)[0]);
        for (const [form, text] of Object.entries(forms)) {
          expect(vars(text), `${name}: placeholders of ${family}.${form}`).toEqual(expected);
        }
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
      const own = families(dict);
      expect(Object.keys(own).length, `${name}: no plural keys found`).toBeGreaterThan(0);
      for (const [family, forms] of Object.entries(own)) {
        for (const suffix of required) {
          expect(forms[suffix], `${name}: ${family}.${suffix}`).toBeTruthy();
        }
      }
    }
  });

  // The forms are listed in the CLDR order (zero, one, two, few, many, other) — the
  // order the base dictionary uses, so two dictionaries can be compared line by line.
  it('the forms of a family are listed in the CLDR order', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      for (const [family, forms] of Object.entries(families(dict))) {
        const listed = Object.keys(forms);
        const ordered = [...listed].sort((a, b) => CLDR_FORMS.indexOf(a) - CLDR_FORMS.indexOf(b));
        expect(listed, `${name}: form order of ${family}`).toEqual(ordered);
      }
    }
  });

  // A dictionary may carry a form its language never selects — the shared key set is
  // the union of the shipped languages' needs. Such a form must be a verbatim copy of
  // .other: real text there reads as a second opinion and rots out of sync on later
  // edits — and the runtime never renders such a form anyway.
  it('plural forms of categories the language does not use copy .other verbatim', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      const required = new Set(requiredPluralSuffixes(name));
      for (const [family, forms] of Object.entries(families(dict))) {
        for (const [form, text] of Object.entries(forms)) {
          if (required.has(form)) continue;
          expect(text, `${name}: ${family}.${form}`).toBe(forms.other);
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
      expect(String(dict['lang.name'] ?? '').trim().length, `${name}: lang.name not empty`).toBeGreaterThan(
        0,
      );
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
