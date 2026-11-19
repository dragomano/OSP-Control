import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';

export function readCargoPackage() {
  const manifest = readFileSync(new NodeURL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  // Dependency tables can have their own version fields.
  const packageSection = manifest
    .split(/^[ \t]*(?=\[)/m)
    .find((section) => /^\[[ \t]*package[ \t]*\][ \t]*(?:#.*)?$/m.test(section));

  const name = packageSection?.match(/^[ \t]*name[ \t]*=[ \t]*(["'])([^\r\n"']+)\1/m)?.[2];
  const version = packageSection?.match(/^[ \t]*version[ \t]*=[ \t]*(["'])([^\r\n"']+)\1/m)?.[2];
  if (!name || !version) throw new Error('cannot read [package] name and version from src-tauri/Cargo.toml');
  return { name, version };
}
