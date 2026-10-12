import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_LANG,
  EMBEDDED_LANGS,
  embeddedDict,
  errorText,
  LANG_NAMES,
  langDisplayName,
  loadLocaleDict,
  loadLocaleList,
  localeIssues,
  localeTag,
  makePlural,
  makeTranslator,
  matchLang,
  missingPluralForms,
  pluralSuffix,
  preferredLang,
} from '../src/i18n';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const t = makeTranslator(
  {
    'greet.hello': 'Привет, {name}!',
    'err.pathInvalid': 'Неверный путь: {path}',
  },
  { 'greet.bye': 'Пока' },
);

describe('makeTranslator', () => {
  it('substitutes variables, including repeated occurrences', () => {
    expect(t('greet.hello', { name: 'Мир' })).toBe('Привет, Мир!');
    expect(makeTranslator({ x: '{n}+{n}={n}' }, {})('x', { n: 2 })).toBe('2+2=2');
  });

  it('falls back to the fallback dictionary', () => {
    expect(t('greet.bye')).toBe('Пока');
  });

  it('returns the key when missing from both dictionaries', () => {
    expect(t('missing.key')).toBe('missing.key');
  });
});

describe('pluralSuffix', () => {
  it('follows the Russian CLDR rules for one/few/many', () => {
    for (const count of [1, 21, 31, 101]) expect(pluralSuffix('ru', count)).toBe('one');
    for (const count of [2, 3, 4, 22, 23, 102]) expect(pluralSuffix('ru', count)).toBe('few');
    for (const count of [0, 5, 11, 12, 14, 20, 25, 111]) expect(pluralSuffix('ru', count)).toBe('many');
    expect(pluralSuffix('ru_RU', 21)).toBe('one');
  });

  it('uses one/other for other languages', () => {
    expect(pluralSuffix('en', 1)).toBe('one');
    for (const count of [0, 2, 5, 21]) expect(pluralSuffix('en', count)).toBe('other');
    expect(pluralSuffix('de', 1)).toBe('one');
    expect(pluralSuffix('de', 3)).toBe('other');
  });

  // The rules come from CLDR (Intl), not a manual denominator check: any locale
  // from the locales folder pluralizes correctly without code changes.
  it('follows the CLDR rules of other Slavic languages', () => {
    expect(pluralSuffix('uk', 1)).toBe('one');
    for (const count of [2, 3, 4, 22]) expect(pluralSuffix('uk', count)).toBe('few');
    for (const count of [0, 5, 11]) expect(pluralSuffix('uk', count)).toBe('many');
    // Polish differs from Russian and Ukrainian exactly at 21 (one vs many).
    expect(pluralSuffix('pl', 21)).toBe('many');
    expect(pluralSuffix('pl', 2)).toBe('few');
  });

  it('covers categories beyond one/other', () => {
    expect(pluralSuffix('ar', 0)).toBe('zero');
    expect(pluralSuffix('ar', 2)).toBe('two');
    expect(pluralSuffix('cs', 1)).toBe('one');
    expect(pluralSuffix('cs', 3)).toBe('few');
  });

  it('treats fractions as other, as CLDR requires', () => {
    expect(pluralSuffix('ru', 1.5)).toBe('other');
  });

  it('falls back to the base language for a broken locale code', () => {
    expect(pluralSuffix('xx_YY', 2)).toBe(pluralSuffix(BASE_LANG, 2));
  });
});

describe('makePlural', () => {
  const plural = makePlural(
    makeTranslator(
      {
        'item.one': '{count} файл',
        'item.few': '{count} файла',
        'item.many': '{count} файлов',
        'legacy.count': 'Файлов: {count}',
      },
      {},
    ),
    'ru',
  );

  it('picks the form by count and injects {count}', () => {
    expect(plural('item', 1)).toBe('1 файл');
    expect(plural('item', 3)).toBe('3 файла');
    expect(plural('item', 11)).toBe('11 файлов');
    expect(plural('item', 0)).toBe('0 файлов');
  });

  it('passes extra vars through to the chosen form', () => {
    const withVars = makePlural(makeTranslator({ 'x.many': '{count} из {total}' }, {}), 'ru');
    expect(withVars('x', 5, { total: 9 })).toBe('5 из 9');
  });

  it('falls back to .many and then to the base key for dictionaries without forms', () => {
    expect(plural('legacy.count', 3)).toBe('Файлов: 3');
    expect(plural('missing.key', 2)).toBe('missing.key');
  });

  // The ru base is a placeholder dictionary: without own it would put Russian forms into any translation.
  it('never borrows a plural form from the fallback dictionary', () => {
    const de: Record<string, string> = {
      'item.many': '{count} Dateien',
      'item.other': '{count} Dateien',
    };
    const deT = makeTranslator(de, embeddedDict(BASE_LANG));
    const dePlural = makePlural(deT, 'de', de);
    // German has no .few — a stray Russian plural form must not be returned.
    expect(dePlural('item', 2)).toBe('2 Dateien');
    expect(dePlural('item', 1)).toBe('1 Dateien');
    // The key is in neither dictionary — the base is returned as is.
    expect(dePlural('missing.key', 2)).toBe('missing.key');
  });

  it('prefers a neutral own form over a singular one for other counts', () => {
    const own = { 'item.one': '{count} Datei' };
    const ownPlural = makePlural(makeTranslator(own, embeddedDict(BASE_LANG)), 'de', own);
    // Incomplete family: for 5, showing "1 Datei" is not allowed — the base key is used.
    expect(ownPlural('item', 1)).toBe('1 Datei');
    expect(ownPlural('item', 5)).toBe('item');
  });

  it('keeps working without the own dictionary', () => {
    const noOwn = makePlural(makeTranslator({ 'item.one': '1 файл', 'item.few': '{count} файла' }, {}), 'ru');
    expect(noOwn('item', 3)).toBe('3 файла');
    // A dictionary without forms keeps working via the base key.
    const legacy = makePlural(makeTranslator({ 'legacy.count': 'Файлов: {count}' }, {}), 'ru');
    expect(legacy('legacy.count', 3)).toBe('Файлов: 3');
    expect(legacy('missing.key', 2)).toBe('missing.key');
  });
});

describe('missingPluralForms', () => {
  const russian = {
    'a.one': '1 файл',
    'a.few': '{count} файла',
    'a.many': '{count} файлов',
    'a.other': '{count} файла',
  };

  it('returns nothing for complete families', () => {
    expect(missingPluralForms(russian, 'ru')).toEqual([]);
  });

  it('judges completeness by the CLDR categories of the language', () => {
    // German only ever has one/other — the family is complete...
    const german = { 'item.one': '1 Datei', 'item.other': '{count} Dateien' };
    expect(missingPluralForms(german, 'de')).toEqual([]);
    // ...but the same family is holey for Russian, and a Russian-style family
    // lacks the zero/two forms Arabic requires.
    expect(missingPluralForms(german, 'ru')).toEqual(['item (few/many)']);
    expect(missingPluralForms(russian, 'ar')).toEqual(['a (zero/two)']);
  });

  it('lists families with absent required forms', () => {
    expect(
      missingPluralForms(
        {
          'a.one': '1 файл',
          'a.many': '{count} файлов',
          'b.one': '{count} Datei',
          'b.many': '{count} Dateien',
          'plain.key': 'без форм',
        },
        'ru',
      ),
    ).toEqual(['a (few/other)', 'b (few/other)']);
  });

  it('ignores a lone .other key that is not a plural family', () => {
    // Even when the lone form belongs to the language's own categories.
    expect(missingPluralForms({ 'services.group.other': 'Прочее' }, 'de')).toEqual([]);
  });

  it('treats optional CLDR categories as extra, not missing', () => {
    expect(missingPluralForms(russian, 'en')).toEqual([]);
  });

  it('ignores dictionaries without plural families', () => {
    expect(missingPluralForms(embeddedDict(BASE_LANG), BASE_LANG)).toEqual([]);
  });
});

describe('localeIssues', () => {
  const base: Record<string, string> = {
    'nav.overview': 'Overview',
    'greet.user': 'Hello, {name}!',
    'plain.key': 'No variables here',
    'item.one': '{count} item',
    'item.few': '{count} items',
    'item.many': '{count} items',
    'item.other': '{count} items',
  };

  it('returns nothing for a complete dictionary', () => {
    expect(localeIssues({ ...base, 'nav.overview': 'Übersicht' }, base, 'ru')).toEqual({
      missingKeys: [],
      unknownKeys: [],
      placeholderMismatches: [],
      incompletePlurals: [],
    });
  });

  it('lists missing and unknown keys sorted', () => {
    const issues = localeIssues(
      { 'nav.overview': 'Übersicht', 'extra.key': 'übrig', 'aaa.extra': 'zuerst' },
      base,
      'ru',
    );
    expect(issues.missingKeys).toEqual([
      'greet.user',
      'item.few',
      'item.many',
      'item.one',
      'item.other',
      'plain.key',
    ]);
    expect(issues.unknownKeys).toEqual(['aaa.extra', 'extra.key']);
  });

  it('detects renamed and absent placeholders', () => {
    const issues = localeIssues(
      {
        'greet.user': 'Hallo, {user}!',
        'plain.key': 'Ohne Variablen',
      },
      base,
      'ru',
    );
    expect(issues.placeholderMismatches).toEqual(['greet.user']);
  });

  it('flags a plural form without {count} and holes in its family', () => {
    const issues = localeIssues(
      {
        'item.one': '{count} Element',
        'item.many': 'Elemente',
      },
      base,
      'ru',
    );
    expect(issues.placeholderMismatches).toEqual(['item.many']);
    expect(issues.incompletePlurals).toEqual(['item (few/other)']);
    // The hole is judged by the language: for German the same family only misses .other.
    const german = localeIssues({ 'item.one': '{count} Element', 'item.many': 'Elemente' }, base, 'de');
    expect(german.incompletePlurals).toEqual(['item (other)']);
  });

  it('does not demand forms of categories the language does not use', () => {
    // A German file only carries one/other: the base few/many keys must not be
    // reported as missing even though the shared key set contains them.
    const german = {
      'nav.overview': 'Übersicht',
      'greet.user': 'Hallo, {name}!',
      'plain.key': 'Ohne Variablen',
      'item.one': '{count} Element',
      'item.other': '{count} Elemente',
    };
    expect(localeIssues(german, base, 'de')).toEqual({
      missingKeys: [],
      unknownKeys: [],
      placeholderMismatches: [],
      incompletePlurals: [],
    });
    // The same file checked as Russian is missing the few/many forms for real.
    expect(localeIssues(german, base, 'ru').missingKeys).toEqual(['item.few', 'item.many']);
  });

  it('accepts extra CLDR forms of a known family for languages that have them', () => {
    // Arabic adds zero/two to every family; the base dictionary does not know them.
    const arabic = { ...base, 'item.zero': '{count} элементов' };
    expect(localeIssues(arabic, base, 'ar').unknownKeys).toEqual([]);
    // For a language without the category the same key stays a suspicious unknown.
    expect(localeIssues(arabic, base, 'de').unknownKeys).toEqual(['item.zero']);
  });

  it('embedded dictionaries have no issues against each other', () => {
    for (const code of EMBEDDED_LANGS) {
      expect(localeIssues(embeddedDict(code), embeddedDict(BASE_LANG), code), code).toEqual({
        missingKeys: [],
        unknownKeys: [],
        placeholderMismatches: [],
        incompletePlurals: [],
      });
    }
  });
});

describe('errorText', () => {
  it('translates an err.* code and substitutes params', () => {
    const err = Object.assign(new Error('err.pathInvalid'), { params: { path: 'C:\\x' } });
    expect(errorText(t, err, 'fallback.key')).toBe('Неверный путь: C:\\x');
  });

  it('translates an Error without params by its message', () => {
    expect(errorText(t, new Error('greet.bye'), 'fallback.key')).toBe('Пока');
  });

  it('uses the fallback for an unknown Error message', () => {
    expect(errorText(t, new Error('raw technical failure'), 'greet.bye')).toBe('Пока');
  });

  it('translates non-Error values using the fallback', () => {
    expect(errorText(t, 'что-то сломалось', 'fallback.key')).toBe('fallback.key');
  });
});

describe('localeTag', () => {
  it('normalizes underscore to dash per BCP-47', () => {
    expect(localeTag('en_US')).toBe('en-US');
  });

  it('falls back to the base language for unknown or malformed codes', () => {
    expect(localeTag('xx_YY')).toBe(BASE_LANG);
    expect(localeTag('')).toBe(BASE_LANG);
  });
});

describe('embedded dictionaries', () => {
  it('the base language is English', () => {
    expect(BASE_LANG).toBe('en');
    expect(embeddedDict(BASE_LANG)['nav.overview']).toBe('Overview');
  });

  it('embeddedDict returns the dictionary for a known code', () => {
    expect(embeddedDict('ru')['nav.overview']).toBe('Обзор');
    expect(embeddedDict('es')['nav.overview']).toBe('Resumen');
    expect(embeddedDict('uk')['nav.overview']).toBe('Огляд');
  });

  it('an unknown language falls back to the base language dictionary', () => {
    expect(embeddedDict('de')).toBe(embeddedDict(BASE_LANG));
  });
});

describe('loadLocaleDict / loadLocaleList without Tauri', () => {
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    invokeMock.mockReset();
  });

  it('loadLocaleDict returns the embedded dictionary', async () => {
    const { dict, fileUsed } = await loadLocaleDict('ru');
    expect(fileUsed).toBe(false);
    expect(dict['nav.overview']).toBe('Обзор');
  });

  it('loadLocaleList lists embedded languages with names from embedded dictionaries', async () => {
    const list = await loadLocaleList();
    expect(list.map((item) => item.code).sort()).toEqual([...EMBEDDED_LANGS].sort());
    for (const item of list) {
      expect(item.name).toBe(LANG_NAMES[item.code]);
    }
  });

  it('langDisplayName falls back to the code for an unknown locale', () => {
    expect(langDisplayName('de')).toBe('DE');
    expect(langDisplayName('ru')).toBe('Русский');
  });
});

describe('loadLocaleDict in Tauri', () => {
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    invokeMock.mockReset();
  });

  it('reads locales/<lang>.json via read_locale and filters out non-strings', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValueOnce(JSON.stringify({ 'a.key': 'ok', bad: 42, list: ['x'] }));
    const { dict, fileUsed } = await loadLocaleDict('de');
    expect(invokeMock).toHaveBeenCalledWith('read_locale', { lang: 'de', allowFile: true });
    expect(fileUsed).toBe(true);
    expect(dict).toEqual({ 'a.key': 'ok' });
  });

  it('falls back to the embedded dictionary when file reading fails', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock
      .mockRejectedValueOnce(new Error('err.localeFileMissing'))
      .mockResolvedValueOnce(JSON.stringify({ 'b.key': 'fallback' }));
    const { dict, fileUsed } = await loadLocaleDict('de');
    expect(invokeMock).toHaveBeenLastCalledWith('read_locale', { lang: 'de', allowFile: false });
    expect(fileUsed).toBe(false);
    expect(dict).toEqual({ 'b.key': 'fallback' });
  });
});

describe('matchLang', () => {
  it('matches an exact code, case-insensitively', () => {
    expect(matchLang('uk', EMBEDDED_LANGS)).toBe('uk');
    expect(matchLang('UK', EMBEDDED_LANGS)).toBe('uk');
    expect(matchLang('ru', EMBEDDED_LANGS)).toBe('ru');
  });

  it('drops the region so ru_RU and ru-BE both give ru', () => {
    expect(matchLang('ru-RU', EMBEDDED_LANGS)).toBe('ru');
    expect(matchLang('ru_RU', EMBEDDED_LANGS)).toBe('ru');
    expect(matchLang('ru-BY', EMBEDDED_LANGS)).toBe('ru');
    expect(matchLang('es-MX', EMBEDDED_LANGS)).toBe('es');
  });

  it('returns undefined when no dictionary matches', () => {
    expect(matchLang('de-DE', EMBEDDED_LANGS)).toBeUndefined();
    expect(matchLang('ja', EMBEDDED_LANGS)).toBeUndefined();
  });
});

describe('preferredLang', () => {
  const withNavigator = (languages: string[], language?: string) => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { languages, language },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  it('uses the first system language available in the app', () => {
    withNavigator(['ru-RU', 'en-US']);
    expect(preferredLang(EMBEDDED_LANGS)).toBe('ru');
  });

  it('falls through to the next system language when the first is missing', () => {
    withNavigator(['de-DE', 'uk-UA']);
    expect(preferredLang(EMBEDDED_LANGS)).toBe('uk');
  });

  it('returns null when no system language is available', () => {
    withNavigator(['de-DE', 'ja-JP']);
    expect(preferredLang(EMBEDDED_LANGS)).toBeNull();
  });

  it('reads navigator.language when languages is empty', () => {
    withNavigator([], 'es-ES');
    expect(preferredLang(EMBEDDED_LANGS)).toBe('es');
  });

  // A Russian system without a Russian dictionary must return null, not Russian: then
  // the calling code falls back to the English base.
  it('never returns a language the app does not have', () => {
    withNavigator(['ru-RU']);
    expect(preferredLang(['en', 'es'])).toBeNull();
  });
});
