import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DemoApp from '../src/demo/DemoApp';
import en from '../src/demo/locales/en.json';
import ru from '../src/demo/locales/ru.json';
import { type DemoBridge, demoDicts, demoLanguages, demoStorage, useDemoBridge } from '../src/demo/runtime';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-ui-palette');
  document.documentElement.style.cssText = '';
  localStorage.removeItem('workshop-test');
  demoStorage.removeItem('workshop-test');
});

function Bridge({ state }: { state: DemoBridge }) {
  useDemoBridge(state);
  return null;
}

describe('workshop isolation and navigation', () => {
  it('keeps preview preferences separate from persistent browser settings', () => {
    localStorage.setItem('workshop-test', 'persistent');
    demoStorage.setItem('workshop-test', 'preview');
    expect(demoStorage.getItem('workshop-test')).toBe('preview');
    expect(localStorage.getItem('workshop-test')).toBe('persistent');
    demoStorage.removeItem('workshop-test');
    expect(demoStorage.getItem('workshop-test')).toBeNull();
    expect(localStorage.getItem('workshop-test')).toBe('persistent');
  });

  it('accepts only known pages and themes from the same-origin parent', () => {
    const state: DemoBridge = {
      page: 'overview',
      theme: 'light',
      palette: 'custom',
      changePalette: vi.fn(),
      lang: 'ru',
      navigate: vi.fn(),
      changeTheme: vi.fn(),
      changeLang: vi.fn(),
    };
    render(<Bridge state={state} />);
    const send = (origin: string, data: Record<string, string>) =>
      fireEvent(
        window,
        new MessageEvent('message', {
          origin,
          source: window.parent,
          data: { type: 'osp-demo-control', ...data },
        }),
      );
    send('https://untrusted.example', { page: 'projects', theme: 'dark' });
    send(window.location.origin, { page: 'unknown', theme: 'unknown', lang: 'unknown' });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.changeTheme).not.toHaveBeenCalled();
    expect(state.changeLang).not.toHaveBeenCalled();
    send(window.location.origin, { page: 'projects', theme: 'dark', lang: 'en' });
    expect(state.navigate).toHaveBeenCalledWith('projects');
    expect(state.changeTheme).toHaveBeenCalledWith('dark');
    expect(state.changeLang).toHaveBeenCalledWith('en');
    for (const lang of Object.keys(demoLanguages)) {
      send(window.location.origin, { lang, palette: 'night' });
      expect(state.changeLang).toHaveBeenCalledWith(lang);
      expect(state.changePalette).toHaveBeenCalledWith('night');
    }
  });

  it('loads the actual application entry for each comparison theme', () => {
    window.history.replaceState(null, '', '/#page=projects&lang=en&mode=compare');
    const { container } = render(<DemoApp />);
    const frames = Array.from(container.querySelectorAll('iframe'));
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.getAttribute('src'))).toEqual([
      './demo-app.html?theme=light&page=projects&lang=en&palette=default',
      './demo-app.html?theme=dark&page=projects&lang=en&palette=default',
    ]);
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frames[0].contentWindow,
        data: { type: 'osp-demo-state', page: 'configs' },
      }),
    );
    expect(screen.getByRole('combobox', { name: 'Page' })).toHaveValue('configs');
    expect(window.location.hash).toContain('page=configs');
  });

  it('compares both modes of a formerly dark-only preset and keeps mode controls enabled', () => {
    window.history.replaceState(null, '', '/#page=settings&lang=en&mode=compare&palette=night');
    const { container } = render(<DemoApp />);
    const frames = Array.from(container.querySelectorAll('iframe'));
    expect(frames.map((frame) => frame.getAttribute('src'))).toEqual([
      './demo-app.html?theme=light&page=settings&lang=en&palette=night',
      './demo-app.html?theme=dark&page=settings&lang=en&palette=night',
    ]);
    for (const name of ['Light', 'Dark', 'Compare themes'])
      expect(screen.getByRole('button', { name })).toBeEnabled();
    const palettes = screen.getByRole('combobox', { name: 'Color theme' });
    expect(palettes.querySelectorAll('option')).toHaveLength(36);
    expect(palettes.querySelector('option[value="light"]')).toBeNull();
    expect(palettes.querySelector('option[value="dark"]')).toBeNull();
  });

  it('synchronizes a preview language change with the toolbar and both comparison frames', () => {
    window.history.replaceState(null, '', '/#page=projects&lang=en&mode=compare');
    const { container } = render(<DemoApp />);
    const frames = Array.from(container.querySelectorAll('iframe'));
    const posts = frames.map((frame) => {
      if (!frame.contentWindow) throw new Error('Preview window is missing');
      return vi.spyOn(frame.contentWindow, 'postMessage');
    });
    const send = (origin: string, source: MessageEventSource | null, lang: string) =>
      fireEvent(
        window,
        new MessageEvent('message', {
          origin,
          source,
          data: { type: 'osp-demo-state', lang },
        }),
      );

    send('https://untrusted.example', frames[0].contentWindow, 'ru');
    send(window.location.origin, window, 'ru');
    send(window.location.origin, frames[0].contentWindow, 'unknown');
    expect(screen.getByRole('combobox', { name: en['demo.language'] })).toHaveValue('en');

    send(window.location.origin, frames[0].contentWindow, 'ru');
    expect(screen.getByRole('combobox', { name: ru['demo.language'] })).toHaveValue('ru');
    expect(window.location.hash).toContain('lang=ru');
    expect(window.location.hash).toContain('page=projects');
    expect(document.documentElement.lang).toBe('ru');
    for (const post of posts)
      expect(post).toHaveBeenLastCalledWith(
        {
          type: 'osp-demo-control',
          page: 'projects',
          lang: 'ru',
          palette: 'default',
          theme: expect.any(String),
        },
        window.location.origin,
      );
    expect(Array.from(container.querySelectorAll('iframe'))).toEqual(frames);
    expect(screen.getByRole('link', { name: ru['demo.fullscreen'] })).toHaveAttribute(
      'href',
      './demo-app.html?page=projects&theme=light&lang=ru&palette=default',
    );

    fireEvent.change(screen.getByRole('combobox', { name: ru['demo.language'] }), {
      target: { value: 'en' },
    });
    expect(screen.getByRole('combobox', { name: en['demo.language'] })).toHaveValue('en');
    for (const post of posts)
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'osp-demo-control', lang: 'en' }),
        window.location.origin,
      );
  });

  it('keeps toolbar translations in parity', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const dict of Object.values(demoDicts))
      expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
  });
});
