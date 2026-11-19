import { Columns2, ExternalLink, Moon, RotateCcw, Sun } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME } from '../brand';
import { applyColorTheme, COLOR_THEMES, colorThemeId, colorThemeIsLight } from '../colorThemes';
import type { Page } from '../components/shared';
import { Button, ButtonLink, Field, Select } from '../components/ui';
import { embeddedDict, langDisplayName, makeTranslator } from '../i18n';
import { applyAccentTheme, useSystemPrefersLight } from '../theme';
import en from './locales/en.json';
import { demoDicts, demoLang, demoLanguages, demoPages } from './runtime';

function Frame({
  theme,
  page,
  lang,
  palette,
  onPalette,
  onNavigate,
  onLang,
  label,
}: {
  theme: 'light' | 'dark';
  page: Page;
  lang: string;
  palette: string;
  onPalette: (id: string) => void;
  onNavigate: (page: Page) => void;
  onLang: (lang: string) => void;
  label: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `./demo-app.html?${new URLSearchParams({ theme, page, lang, palette })}`);
  useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { type: 'osp-demo-control', page, lang, palette, theme },
      window.location.origin,
    );
  }, [page, lang, palette, theme]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== ref.current?.contentWindow ||
        event.data?.type !== 'osp-demo-state'
      )
        return;
      if (demoPages.includes(event.data.page)) onNavigate(event.data.page);
      if (colorThemeId(event.data.palette) === event.data.palette) onPalette(event.data.palette);
      if (Object.keys(demoLanguages).includes(event.data.lang)) onLang(event.data.lang);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onNavigate, onPalette, onLang]);
  return (
    <section className="workshop-frame" data-theme={theme}>
      <iframe
        ref={ref}
        title={label}
        src={src}
        onLoad={() =>
          ref.current?.contentWindow?.postMessage(
            { type: 'osp-demo-control', page, lang, palette, theme },
            window.location.origin,
          )
        }
      />
    </section>
  );
}

export default function DemoApp() {
  const initial = useMemo(() => new URLSearchParams(window.location.hash.slice(1)), []);
  const [page, setPage] = useState<Page>(
    demoPages.find((item) => item === initial.get('page')) ?? 'overview',
  );
  const systemLight = useSystemPrefersLight();
  const [mode, setMode] = useState<'light' | 'dark' | 'compare'>(() => {
    const stored = initial.get('mode');
    if (stored === 'compare' || stored === 'light' || stored === 'dark') return stored;
    return systemLight ? 'light' : 'dark';
  });
  const [lang, setLang] = useState(demoLang(initial.get('lang')));
  const [palette, setPalette] = useState(colorThemeId(initial.get('palette') ?? 'default'));
  const nativeMode = colorThemeIsLight(palette, mode === 'dark' ? 'dark' : 'light', false) ? 'light' : 'dark';
  const [generation, setGeneration] = useState(0);
  const t = makeTranslator({ ...embeddedDict(lang), ...demoDicts[lang] }, { ...embeddedDict('en'), ...en });
  useEffect(() => {
    applyAccentTheme('blue');
    applyColorTheme(palette, nativeMode === 'light');
    document.documentElement.lang = lang;
    window.history.replaceState(
      null,
      '',
      `#${new URLSearchParams({ page, theme: nativeMode, mode, lang, palette })}`,
    );
  }, [nativeMode, mode, lang, page, palette]);
  const fullscreen = `./demo-app.html?${new URLSearchParams({ page, theme: nativeMode, lang, palette })}`;
  return (
    <div className="workshop">
      <header className="workshop-header">
        <div>
          <strong>
            {APP_NAME} <span>DaisyUI 5</span>
          </strong>
          <p>{t('demo.actualApp')}</p>
        </div>
        <div className="workshop-controls">
          <Field>
            {t('demo.page')}
            <Select value={page} onChange={(event) => setPage(event.target.value as Page)}>
              {demoPages.map((item) => (
                <option key={item} value={item}>
                  {t(`nav.${item}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            {t('settings.paletteTitle')}
            <Select value={palette} onChange={(event) => setPalette(event.target.value)}>
              {Object.entries(COLOR_THEMES).map(([id, theme]) => (
                <option key={id} value={id}>
                  {theme.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="join">
            {(
              [
                { id: 'light', icon: Sun, key: 'demo.light' },
                { id: 'dark', icon: Moon, key: 'demo.dark' },
                { id: 'compare', icon: Columns2, key: 'demo.compare' },
              ] as const
            ).map(({ id, icon: Icon, key }) => (
              <Button
                variant={mode === id ? 'primary' : 'secondary'}
                type="button"
                key={id}
                className="join-item"
                aria-pressed={mode === id}
                onClick={() => setMode(id)}
              >
                <Icon size={15} />
                {t(key)}
              </Button>
            ))}
          </div>
          <Field>
            {t('demo.language')}
            <Select value={lang} onChange={(event) => setLang(event.target.value)}>
              {Object.keys(demoLanguages).map((id) => (
                <option key={id} value={id}>
                  {langDisplayName(id)}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="ghost"
            square
            type="button"
            aria-label={t('demo.reset')}
            title={t('demo.reset')}
            onClick={() => setGeneration((value) => value + 1)}
          >
            <RotateCcw size={16} />
          </Button>
          <ButtonLink href={fullscreen} target="_blank" rel="noreferrer">
            <ExternalLink size={15} />
            {t('demo.fullscreen')}
          </ButtonLink>
        </div>
      </header>
      <div className="workshop-notice">
        <p>{t('demo.notice')}</p>
        <p>{t('demo.review')}</p>
      </div>
      <main className={`workshop-previews ${mode === 'compare' ? 'comparing' : ''}`}>
        {(mode === 'compare'
          ? (['light', 'dark'] as const)
          : ([mode === 'dark' ? 'dark' : 'light'] as const)
        ).map((theme) => (
          <div className="workshop-lane" key={`${theme}-${generation}`}>
            <div className="workshop-theme-label">
              {theme === 'light' ? <Sun size={14} /> : <Moon size={14} />}
              {t(`demo.${theme}`)}
            </div>
            <Frame
              theme={theme}
              page={page}
              lang={lang}
              palette={palette}
              onPalette={setPalette}
              onNavigate={setPage}
              onLang={setLang}
              label={t('demo.appFrame', { theme: t(`demo.${theme}`) })}
            />
          </div>
        ))}
      </main>
    </div>
  );
}
