import '@fortawesome/fontawesome-free/css/solid.css';
import '@fortawesome/fontawesome-free/css/regular.css';
import '@fortawesome/fontawesome-free/css/brands.css';
import { CircleHelp } from 'lucide-react';
import catalog from './menuIconCatalog.json';

export type MenuIconEntry = {
  value: string;
  style: string;
  unicode: string;
  aliases: string[];
  terms: string;
  path?: string;
  width?: number;
  height?: number;
};

export const menuIcons: MenuIconEntry[] = Object.entries(catalog).map(([value, row]) => {
  const [style, unicode, aliases, terms, path, width, height] = row.split('|');
  return {
    value,
    style,
    unicode,
    aliases: aliases ? aliases.split(' ') : [],
    terms,
    ...(path ? { path, width: Number(width), height: Number(height) } : {}),
  };
});
const byName = new Map<string, MenuIconEntry>();
for (const entry of menuIcons) {
  byName.set(entry.value, entry);
  for (const alias of entry.aliases) byName.set(alias, entry);
}

export function MenuIcon({ name }: { name?: string }) {
  if (!name) return null;
  const entry = byName.get(name);
  if (entry?.path) {
    return (
      <svg className="menu-fa-fallback" viewBox={`0 0 ${entry.width} ${entry.height}`} aria-hidden="true">
        <path d={entry.path} />
      </svg>
    );
  }
  return entry ? (
    <span className={`menu-fa-icon menu-fa-${entry.style}`} aria-hidden="true">
      {String.fromCodePoint(Number.parseInt(entry.unicode, 16))}
    </span>
  ) : (
    <CircleHelp size={16} aria-hidden="true" />
  );
}
