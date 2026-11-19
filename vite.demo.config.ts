import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preact } from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { readCargoPackage } from './scripts/cargo-package.mjs';
import { daisyUIStyles } from './scripts/daisyui.ts';

const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const { productName } = JSON.parse(readFileSync(path('./src-tauri/tauri.conf.json'), 'utf8')) as {
  productName: string;
};

// Adapt the existing application only for this entry point; production sources stay unchanged.
function workshop(): Plugin {
  return {
    name: 'osp-daisyui-workshop',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        /^(?:\.\.?\/)+ospanel(?:\.ts)?$/.test(source) &&
        !importer?.replaceAll('\\', '/').endsWith('/demo/adapter.ts')
      )
        return path('./src/demo/adapter.ts');
    },
    transform(code, id) {
      const normalized = id.split('?')[0].replaceAll('\\', '/');
      if (!normalized.includes('/src/') || normalized.includes('/src/demo/')) return;
      if (normalized.endsWith('/settingsStorage.ts') || normalized.endsWith('/ospanel.ts'))
        return {
          code: `import { demoStorage } from '/src/demo/runtime';\n${code.replace(/\blocalStorage\b/g, 'demoStorage')}`,
          map: null,
        };
      if (normalized.endsWith('/App.tsx')) {
        const state = "const [page, setPage] = useState<Page>('overview');";
        const root = 'return (\n    <I18nContext.Provider';
        if (!code.includes(state) || !code.includes(root))
          throw new Error('Update the workshop bridge for the current App.tsx');
        return {
          code: `import { initialDemoPage, useDemoBridge } from '/src/demo/runtime';\n${code.replace(state, 'const [page, setPage] = useState<Page>(initialDemoPage);').replace(root, 'useDemoBridge({ page, theme: themeMode, palette: colorTheme, lang, navigate: navigateTo, changeTheme, changeLang, changePalette: changeColorTheme });\n  return (\n    <I18nContext.Provider')}`,
          map: null,
        };
      }
    },
  };
}

export default defineConfig({
  plugins: [workshop(), daisyUIStyles(), preact(), tailwindcss()],
  define: {
    'import.meta.env.VITE_APP_NAME': JSON.stringify(productName),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(readCargoPackage().version),
    'import.meta.env.VITE_UI_WORKSHOP': JSON.stringify('1'),
  },
  server: { host: '127.0.0.1', port: 1421, strictPort: true },
  build: {
    outDir: 'dist-demo',
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      input: { demo: path('./demo.html'), app: path('./demo-app.html') },
      output: {
        codeSplitting: {
          groups: [{ name: 'locales', test: /[\\/]resources[\\/]locales[\\/][^\\/]+\.json$/ }],
        },
      },
    },
  },
});
