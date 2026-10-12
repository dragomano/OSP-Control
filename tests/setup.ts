import '@testing-library/jest-dom/vitest';

// jsdom does not implement window.matchMedia — needed by useSystemPrefersLight in theme.ts.
const matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

Object.defineProperty(window, 'matchMedia', { writable: true, value: matchMedia });
