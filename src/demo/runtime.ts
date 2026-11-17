import { useEffect, useRef } from 'react';
import { colorThemeId } from '../colorThemes';
import type { Page } from '../components/shared';
import type { ThemeMode } from '../theme';
import be from './locales/be.json';
import en from './locales/en.json';
import es from './locales/es.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';
import projectTagColors from './projectTagColors.defaults.json';

export const demoPages: Page[] = [
  'overview',
  'services',
  'projects',
  'configs',
  'menu',
  'logs',
  'backups',
  'settings',
];
const params = new URLSearchParams(window.location.search);
export const demoLanguages = Object.fromEntries(
  ['ru', 'en', 'uk', 'be', 'es'].map((id) => {
    return [id, id];
  }),
);
export const demoDicts: Record<string, typeof en> = { en, ru, uk, be, es };
export const demoLang = (id: string | null) => (id && Object.keys(demoLanguages).includes(id) ? id : 'ru');
const t = (key: keyof typeof en) => demoDicts[demoLang(params.get('lang'))][key];
export const demoText = t;
const values = new Map<string, string>([
  ['ospanel.lang', demoLang(params.get('lang'))],
  ['ospanel.colorTheme', colorThemeId(params.get('palette') ?? 'custom')],
  ['ospanel.theme', params.get('theme') === 'dark' ? 'dark' : 'light'],
  ['ospanel.accent', 'orange'],
  ['ospanel.font', 'segoe'],
  ['ospanel.scale', '100'],
  [
    'ospanel.projectTags',
    JSON.stringify({
      version: 1,
      projects: {
        'my-shop.test': [t('demo.tagClient'), t('demo.tagDevelopment')],
        'api.test': [t('demo.tagApi'), t('demo.tagDevelopment')],
      },
      colors: {
        [t('demo.tagClient').toLowerCase()]: projectTagColors.client,
        [t('demo.tagDevelopment').toLowerCase()]: projectTagColors.development,
        [t('demo.tagApi').toLowerCase()]: projectTagColors.api,
      },
    }),
  ],
]);

// Vite substitutes this storage only in the workshop build. Each iframe owns its data.
export const demoStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() {
    return values.size;
  },
};

export function initialDemoPage(): Page {
  const candidate = params.get('page');
  return demoPages.find((page) => page === candidate) ?? 'overview';
}

export type DemoBridge = {
  page: Page;
  theme: ThemeMode;
  palette: string;
  lang: string;
  navigate: (page: Page) => void;
  changeTheme: (theme: ThemeMode) => void;
  changePalette: (id: string) => void;
  changeLang: (lang: string) => void;
};

export function useDemoBridge(state: DemoBridge) {
  const current = useRef(state);
  current.current = state;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== window.parent ||
        event.data?.type !== 'osp-demo-control'
      )
        return;
      const message = event.data;
      if (demoPages.includes(message.page)) current.current.navigate(message.page);
      if (message.theme === 'light' || message.theme === 'dark') current.current.changeTheme(message.theme);
      if (Object.keys(demoLanguages).includes(message.lang)) current.current.changeLang(message.lang);
      if (typeof message.palette === 'string' && colorThemeId(message.palette) === message.palette)
        current.current.changePalette(message.palette);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    const theme =
      state.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : state.theme;
    if (window.parent === window)
      window.history.replaceState(
        null,
        '',
        `?${new URLSearchParams({ page: state.page, theme, lang: state.lang, palette: state.palette })}`,
      );
    if (window.parent !== window)
      window.parent.postMessage(
        { type: 'osp-demo-state', page: state.page, theme, palette: state.palette, lang: state.lang },
        window.location.origin,
      );
  }, [state.page, state.theme, state.palette, state.lang]);
}
