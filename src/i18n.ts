import { createContext, useContext } from 'react';
import beJson from '../src-tauri/resources/locales/be.json';
import enJson from '../src-tauri/resources/locales/en.json';
import esJson from '../src-tauri/resources/locales/es.json';
import ruJson from '../src-tauri/resources/locales/ru.json';
import ukJson from '../src-tauri/resources/locales/uk.json';
import { isDesktopApp } from './ospanel';

export type Dict = Record<string, string>;
export type LocaleInfo = { code: string; name: string };
export type Translator = (key: string, vars?: Record<string, string | number>) => string;

// The base language is English: it doubles as the placeholder for incomplete
// user-supplied files and for locale codes Intl does not know. Russian is not
// used in that role — otherwise Russian strings would leak into other translations.
const EMBEDDED: Record<string, Dict> = {
  en: enJson as Dict,
  ru: ruJson as Dict,
  be: beJson as Dict,
  es: esJson as Dict,
  uk: ukJson as Dict,
};

export const BASE_LANG = 'en';
export const embeddedDict = (lang: string): Dict => EMBEDDED[lang] ?? EMBEDDED[BASE_LANG];
// Dictionaries known before files are loaded from the locales folder — the basis of the startup language choice.
export const EMBEDDED_LANGS = Object.keys(EMBEDDED);

function parseDict(raw: string): Dict {
  const parsed: unknown = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid locale file');

  const dict: Dict = {};

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') dict[key] = value;
  }

  return dict;
}

// Reads locales/<lang>.json next to the exe; on a missing/broken file — the embedded dictionary.
export async function loadLocaleDict(lang: string): Promise<{ dict: Dict; fileUsed: boolean }> {
  if (!isDesktopApp()) return { dict: embeddedDict(lang), fileUsed: false };

  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return {
      dict: parseDict(await invoke<string>('read_locale', { lang, allowFile: true })),
      fileUsed: true,
    };
  } catch {
    return {
      dict: parseDict(await invoke<string>('read_locale', { lang, allowFile: false })),
      fileUsed: false,
    };
  }
}

// Language names are in their own language, defined inside each dictionary (the lang.name key).
// For embedded dictionaries the map is built automatically to avoid duplicating the code.
export const LANG_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(EMBEDDED).map(([code, dict]) => [code, dict['lang.name'] ?? code.toUpperCase()]),
);

// Language name for the UI: from the embedded dictionary, otherwise the code itself
// in upper case (a user file in the locales folder with its own code, if no name is defined).
export function langDisplayName(code: string): string {
  return LANG_NAMES[code] ?? EMBEDDED[code]?.['lang.name'] ?? code.toUpperCase();
}

// Language list: embedded ones + every valid *.json in the locales folder (picked up on the fly).
export async function loadLocaleList(): Promise<LocaleInfo[]> {
  if (!isDesktopApp()) {
    return Object.keys(EMBEDDED).map((code) => ({ code, name: langDisplayName(code) }));
  }

  const { invoke } = await import('@tauri-apps/api/core');

  return invoke<LocaleInfo[]>('list_locales');
}

export function makeTranslator(dict: Dict, fallback: Dict): Translator {
  return (key, vars) => {
    let text = dict[key] ?? fallback[key] ?? key;

    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }

    return text;
  };
}

// Plural forms live in dictionaries as <key>.one/.few/.many/.other (CLDR suffixes).
// The category is chosen by Intl.PluralRules, not by a manual denominator check: uk/pl/cs/lt
// have their own category sets, Arabic has six (zero/one/two/few/many/other), and any such
// locale is picked up from the locales folder without code changes. The objects are cached —
// plural() is called on every list render, and creating PluralRules is far costlier than a lookup.
const pluralRulesCache = new Map<string, Intl.PluralRules>();

function pluralRules(lang: string): Intl.PluralRules {
  const tag = localeTag(lang);
  const cached = pluralRulesCache.get(tag);

  if (cached) return cached;

  let rules: Intl.PluralRules;

  try {
    rules = new Intl.PluralRules(tag);
  } catch {
    rules = new Intl.PluralRules(BASE_LANG);
  }

  pluralRulesCache.set(tag, rules);

  return rules;
}

export function pluralSuffix(lang: string, count: number): string {
  return pluralRules(lang).select(count);
}

// Form lookup order: the exact plural category → the language's other categories → neutral
// many/other. The singular one is not put in the tail: "5 Datei" from the form for 1 is worse
// than a neutral form or the base key. Neutral suffixes come last, for dictionaries where
// some of the language's categories are untranslated.
function pluralCandidates(lang: string, count: number): string[] {
  const categories = pluralRules(lang).resolvedOptions().pluralCategories;

  return [...new Set([pluralSuffix(lang, count), ...categories.filter((c) => c !== 'one'), 'many', 'other'])];
}

export type Plural = (key: string, count: number, vars?: Record<string, string | number>) => string;

// The form is looked up in the own dictionary first: substituting a Russian form into a
// translation in another language is exactly the defect that silently ruins a locale file
// (a stray wrong-number Russian form appearing in German). That is why, for an incomplete form family, only the
// neutral form (many/other) is taken: "1 Datei" in place of "5 Dateien" at least stays in
// its own language, and the base key beats a singular form with the wrong number. The
// English base is connected only for a key missing from the own dictionary entirely —
// that way legacy dictionaries without forms keep working.
export function makePlural(t: Translator, lang: string, own?: Dict): Plural {
  return (key, count, vars) => {
    const allVars = { ...vars, count };

    if (own) {
      for (const suffix of pluralCandidates(lang, count)) {
        const candidate = `${key}.${suffix}`;

        if (own[candidate] !== undefined) return t(candidate, allVars);
      }

      if (own[key] !== undefined) return t(key, allVars);
    }

    for (const suffix of pluralCandidates(lang, count)) {
      const candidate = `${key}.${suffix}`;
      const text = t(candidate, allVars);

      if (text !== candidate) return text;
    }

    return t(key, allVars);
  };
}

// The plural forms a language actually needs: its own CLDR categories, restricted to
// the six known suffixes. German lives on one/other, Russian requires one/few/many,
// Arabic adds zero/two — demanding the fixed Russian-style set from every dictionary
// would force translators to invent forms their language never uses. Exported so the
// parity tests validate dictionaries by the same rule the app applies at runtime.
export function requiredPluralSuffixes(lang: string): string[] {
  const known = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

  return pluralRules(lang)
    .resolvedOptions()
    .pluralCategories.filter((category) => known.has(category));
}

// <family>.<suffix> for the six CLDR suffixes; the family itself may contain dots.
const PLURAL_FORM_RE = /^(.+)\.(zero|one|two|few|many|other)$/;

// Plural families with gaps: the locale file is loaded by the user, and a holey translation
// would otherwise only show up as a stray Russian form in the middle of a German UI. What
// counts as a hole is decided by the language itself (requiredPluralSuffixes). A family means
// two or more suffixes sharing a base: a lone "services.group.other" is a regular section key,
// not a word form, and demanding .one from it would be a false alarm.
export function missingPluralForms(dict: Dict, lang: string): string[] {
  const families = new Map<string, Set<string>>();

  for (const entry of Object.keys(dict)) {
    const match = PLURAL_FORM_RE.exec(entry);

    if (!match) continue;

    const [, base, suffix] = match;
    const present = families.get(base);

    if (present) present.add(suffix);
    else families.set(base, new Set([suffix]));
  }

  const required = requiredPluralSuffixes(lang);
  const missing: string[] = [];

  for (const [base, present] of families) {
    if (present.size < 2) continue;

    const absent = required.filter((suffix) => !present.has(suffix));

    if (absent.length > 0) missing.push(`${base} (${absent.join('/')})`);
  }

  return missing.sort();
}

export type LocaleIssues = {
  // Keys present in the base dictionary but absent from the own one: they silently
  // render English through the fallback, so the user cannot see the gap.
  missingKeys: string[];
  // Keys the base dictionary does not know: typos or leftovers that never translate.
  unknownKeys: string[];
  // Keys whose {var} names differ from the base one: substitution silently renders
  // a literal "{var}" or puts a value into the wrong spot.
  placeholderMismatches: string[];
  // Plural families with holes (see missingPluralForms).
  incompletePlurals: string[];
};

// {var} names of one value, sorted: a set comparison, order of occurrence is irrelevant.
const placeholderNames = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

// Structural check of a user locale file against the base dictionary. Every category
// degrades the UI silently — missing keys fall back to English, a renamed {var} stays
// literal, a holey plural family shows a form for the wrong number — so the caller
// turns the result into a user-facing warning instead of parsing the dictionary ad hoc.
// Plural forms are judged by the CLDR categories of lang, the language of the file: the
// base key set is the union of the shipped languages' needs, so a .few key is optional
// in a German file, and an item.zero form is legitimate in an Arabic one.
export function localeIssues(own: Dict, base: Dict, lang: string): LocaleIssues {
  const baseKeys = new Set(Object.keys(base));
  const ownKeys = new Set(Object.keys(own));
  const required = requiredPluralSuffixes(lang);
  const missingKeys: string[] = [];
  const placeholderMismatches: string[] = [];

  for (const key of Object.keys(base)) {
    const form = PLURAL_FORM_RE.exec(key);

    if (form && !required.includes(form[2])) continue;
    if (!ownKeys.has(key)) {
      missingKeys.push(key);
      continue;
    }

    const expected = placeholderNames(base[key]);
    const actual = placeholderNames(own[key]);

    if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
      placeholderMismatches.push(key);
    }
  }

  const unknownKeys = Object.keys(own)
    .filter((key) => {
      if (baseKeys.has(key)) return false;

      const form = PLURAL_FORM_RE.exec(key);

      // A category of the language itself on a family the base dictionary knows is a
      // legitimate form, not a typo; on an unknown family it stays a suspicious key.
      if (form && required.includes(form[2])) {
        const familyPrefix = `${form[1]}.`;

        return !Object.keys(base).some((baseKey) => baseKey.startsWith(familyPrefix));
      }

      return true;
    })
    .sort();

  return {
    // Sorted: the output must not depend on the JSON key order of either file.
    missingKeys: missingKeys.sort(),
    unknownKeys,
    placeholderMismatches: placeholderMismatches.sort(),
    incompletePlurals: missingPluralForms(own, lang),
  };
}

// Adapter and Rust command errors are err.* codes in message (+ optional params).
// Unknown implementation messages must use the caller's localized fallback instead of leaking raw text.
export function errorText(t: Translator, error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return t(fallback);

  let params = (error as Error & { params?: Record<string, string> }).params;
  if (params?.cause?.startsWith('err.')) {
    const { cause, ...causeParams } = params;
    const causeError = Object.assign(new Error(cause), { params: causeParams });
    params = { ...params, cause: errorText(t, causeError, fallback) };
  }
  const translated = t(error.message, params);

  return translated === error.message ? t(fallback) : translated;
}

// Locale tag for Intl: codes from locales may use "_", BCP-47 requires "-".
// An unknown or broken code falls back to the base language — no need to register new locales.
export function localeTag(lang: string): string {
  const tag = lang.replace('_', '-');

  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag])[0] ?? BASE_LANG;
  } catch {
    return BASE_LANG;
  }
}

// System languages: the Tauri webview is a browser engine, so navigator.languages
// returns the OS language along with the user's preference order. No need to know
// anything about Windows or the specific OS locale: the list arrives ready-made.
export function systemLangs(): string[] {
  if (typeof navigator === 'undefined') return [];

  const list =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? [...navigator.languages]
      : [navigator.language].filter((code): code is string => Boolean(code));

  return list.filter((code) => typeof code === 'string' && code.length > 0);
}

// System language → code from the dictionaries: ru_RU and ru-BE both give ru. The region
// is dropped deliberately — dictionaries are bilingual, there are no variants like pt_BR in them.
export function matchLang(tag: string, available: string[]): string | undefined {
  const normalized = tag.replace('_', '-');
  const exact = available.find((code) => code.toLowerCase() === normalized.toLowerCase());

  if (exact) return exact;

  const primary = normalized.split('-')[0].toLowerCase();

  return available.find((code) => code.toLowerCase() === primary);
}

// Initial language: the first match from OS preferences, otherwise the English base.
// Returns null when there are no matches — the caller decides how to react
// (a Russian system without a Russian dictionary must not silently get an English UI).
export function preferredLang(available: string[]): string | null {
  for (const tag of systemLangs()) {
    const hit = matchLang(tag, available);

    if (hit) return hit;
  }

  return null;
}

export type I18n = { lang: string; t: Translator; plural: Plural };
export const I18nContext = createContext<I18n>({
  lang: BASE_LANG,
  t: (key) => key,
  plural: (key) => key,
});
export const useI18n = () => useContext(I18nContext);
