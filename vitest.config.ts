import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { readCargoPackage } from './scripts/cargo-package.mjs';

// Tests run against React, not the Preact production runtime: the Vitest
// environment externalizes node_modules, so a react -> preact/compat alias
// would not reach @testing-library/react's react-dom (and React-based libs
// like lucide-react), mixing two runtimes. The Preact swap
// is validated by the production build and a manual smoke test.
export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(readCargoPackage().version) },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    clearMocks: true,
    coverage: {
      // Measure the application code only; test files and tooling stay out of the report.
      include: ['src/**/*.{ts,tsx}'],
      // main.tsx is bootstrap glue (createRoot + mount) exercised only by the real shell.
      // brand.ts exports constants checked by brand.test.ts and version.test.ts.
      // The v8 remapper reports 0% for it regardless of execution.
      // The isolated UI workshop is not part of the desktop application bundle.
      exclude: ['src/**/*.d.ts', 'src/main.tsx', 'src/brand.ts', 'src/demo/**'],
      reporter: ['text-summary', 'html'],
      // Floor set slightly under the suite baseline (~83/76/84/86) to block regressions;
      // the remaining gap is mostly desktop-only invoke branches in ospanel.ts.
      thresholds: {
        statements: 80,
        branches: 73,
        functions: 81,
        lines: 83,
      },
    },
  },
});
