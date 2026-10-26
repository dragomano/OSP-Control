// OSPanel 6.5.1 embeds Font Awesome 6.5.2. Keep that metadata baseline pinned,
// while runtime fonts update independently. Only the baseline's names are saved to menu.dat.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const source = new URL(
  '../node_modules/@fortawesome/fontawesome-free/metadata/icon-families.json',
  import.meta.url,
);
const icons = JSON.parse(readFileSync(source, 'utf8'));
const baseline = JSON.parse(
  readFileSync(
    new URL(
      '../node_modules/@fortawesome/fontawesome-free-ospanel/metadata/icon-families.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const current = new Map();
for (const [name, data] of Object.entries(icons)) {
  for (const { family, style } of data.familyStylesByLicense.free) {
    if (family !== 'classic') continue;
    for (const alias of [name, ...(data.aliases?.names ?? [])]) current.set(`${style}:${alias}`, data);
  }
}
const catalog = {};
for (const [name, data] of Object.entries(baseline)) {
  for (const { family, style } of data.familyStylesByLicense.free) {
    if (family !== 'classic') continue;
    const value = style === 'regular' ? `regular-${name}` : name;
    const aliases = (data.aliases?.names ?? []).map((alias) =>
      style === 'regular' ? `regular-${alias}` : alias,
    );
    const preview = current.get(`${style}:${name}`);
    const fields = [
      style,
      preview?.unicode ?? data.unicode,
      aliases.join(' '),
      data.search.terms.join(' ').replaceAll('|', ' '),
    ];
    if (!preview) {
      // A native icon removed from newer Free fonts still needs a faithful preview.
      const svg = data.svgs.classic[style];
      fields.push(svg.path, String(svg.width), String(svg.height));
    }
    catalog[value] = fields.join('|');
  }
}
const destination = new URL('../src/menuIconCatalog.json', import.meta.url);
const existing = existsSync(destination) ? readFileSync(destination, 'utf8') : '';
if (process.argv.includes('--check')) {
  if (!existing || JSON.stringify(JSON.parse(existing)) !== JSON.stringify(catalog)) {
    throw new Error('Menu icon catalog is stale. Run node scripts/generate-menu-icons.mjs.');
  }
} else {
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  if (existing !== content) writeFileSync(destination, content);
}
