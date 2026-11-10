import { readFileSync } from 'node:fs';
import { preact } from '@preact/preset-vite';
import { defineConfig } from 'vite';

// The single source of the product name is productName in tauri.conf.json.
// Vite substitutes it for %VITE_APP_NAME% in index.html,
// and the frontend reads it directly from the same JSON (src/brand.ts).
const { productName } = JSON.parse(
  readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { productName: string };

export default defineConfig({
  plugins: [preact()],
  define: { 'import.meta.env.VITE_APP_NAME': JSON.stringify(productName) },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Keep the runtime, embedded fallback dictionaries and syntax engine independently cacheable.
            { name: 'preact-vendor', test: /[\\/]node_modules[\\/](?:preact)[\\/]/ },
            { name: 'locales', test: /[\\/]src-tauri[\\/]resources[\\/]locales[\\/][^\\/]+\.json$/ },
            {
              name: 'syntax-highlighter',
              test: /[\\/](?:node_modules[\\/]highlight\.js[\\/]|src[\\/]highlight\.ts$)/,
            },
          ],
        },
      },
    },
  },
});
