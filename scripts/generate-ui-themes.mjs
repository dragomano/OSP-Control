import { writeFileSync } from 'node:fs';
import themes from 'daisyui/theme/object';

// Keep documentation order stable rather than relying on package object order.
const names =
  'light dark cupcake bumblebee emerald corporate synthwave retro cyberpunk valentine halloween garden forest aqua lofi pastel fantasy wireframe black luxury dracula cmyk autumn business acid lemonade night coffee winter dim nord sunset caramellatte abyss silk'.split(
    ' ',
  );
const colors = Object.fromEntries(
  names.map((name) => [
    name,
    Object.fromEntries(
      Object.entries(themes[name]).filter(([key]) => key === 'color-scheme' || key.startsWith('--color-')),
    ),
  ]),
);
writeFileSync(
  new URL('../src/palettes/daisyui.json', import.meta.url),
  `${JSON.stringify(colors, null, 2)}\n`,
);
const custom = Object.fromEntries(
  ['light', 'dark'].map((mode) => [
    mode,
    {
      ...colors[mode],
      '--color-primary': mode === 'light' ? 'var(--lt-accent)' : 'var(--k-eda75f)',
      '--color-primary-content': mode === 'light' ? 'var(--lt-on-accent)' : 'var(--k-2b1a08)',
    },
  ]),
);
// Custom is edited separately; regeneration never overwrites user palettes.
if (process.argv.includes('--seed-custom'))
  writeFileSync(
    new URL('../src/palettes/custom.json', import.meta.url),
    `${JSON.stringify({ custom: { name: 'Custom', ...custom } }, null, 2)}\n`,
  );
