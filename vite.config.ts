import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The single source of the product name is productName in tauri.conf.json.
// In index.html it is substituted as %VITE_APP_NAME% (see htmlEnvHook),
// and the frontend reads it directly from the same JSON (src/brand.ts).
const { productName } = JSON.parse(
  readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { productName: string };

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_APP_NAME': JSON.stringify(productName) },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Cache the React runtime independently of application code and dictionaries.
          groups: [
            { name: 'react-vendor', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
