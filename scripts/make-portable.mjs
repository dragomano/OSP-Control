// Assembles the portable distribution after `tauri build`.
//
// The project ships no installers: bundling is switched off in
// src-tauri/tauri.conf.json, so `tauri build` only produces the executable (tauri-build
// still copies bundle.resources — the locales — next to it). What we hand out is a
// folder with the executable and the editable dictionaries beside it:
//
//   dist-portable/OSP_Control_<version>_<arch>/
//     osp-control.exe
//     locales/*.json
//
// There is no zip here: the CI zips the folder for the release asset, and locally the
// folder is what a user copies to a USB stick.
//
// Usage: node scripts/make-portable.mjs [releaseDir] [outRoot] [arch]
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Paths of the project files are derived from this script, not from the working
// directory: the script is run both by `pnpm tauri:build` and by its test.
const repoRoot = path.resolve(import.meta.dirname, '..');

// Tauri names bundles after these architecture tokens; an unknown host keeps its own.
const archTokens = { x64: 'x64', arm64: 'arm64', ia32: 'x86' };

// Everything that ends up in the output path goes through this check: the arguments
// are the only untrusted input here, and a folder name must stay a folder name.
const safeName = /^[A-Za-z0-9._+-]+$/;

const arg = (index) => process.argv[index + 2];

// Exits with a message on stderr and a failing status — an incomplete distribution
// must never look like a successful build.
const fail = (message) => {
  console.error(`make-portable: ${message}`);
  process.exit(1);
};

const releaseDir = path.resolve(arg(0) ?? path.join(repoRoot, 'src-tauri', 'target', 'release'));
const outRoot = path.resolve(arg(1) ?? path.join(repoRoot, 'dist-portable'));
const arch = arg(2) ?? archTokens[process.arch] ?? process.arch;

const tauriConfig = JSON.parse(await readFile(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;

// The executable is named after the Cargo package; productName only names the
// distribution (and the window), so it is normalized: spaces become underscores.
const manifest = await readFile(path.join(repoRoot, 'src-tauri', 'Cargo.toml'), 'utf8');
const manifestStart = manifest.indexOf('[package]');
const manifestEnd = manifest.indexOf('\n[', manifestStart);
const packageSection = manifest.slice(manifestStart, manifestEnd === -1 ? undefined : manifestEnd);
const crateName = packageSection.match(/^name\s*=\s*"([^"]+)"/m)?.[1];

const productName = String(tauriConfig.productName ?? '').replaceAll(' ', '_');
if (!crateName) fail('cannot read [package] name from src-tauri/Cargo.toml');
if (!productName || !safeName.test(productName)) {
  fail(
    `productName from tauri.conf.json is not usable as a folder name: ${JSON.stringify(tauriConfig.productName)}`,
  );
}
if (!safeName.test(version))
  fail(`package.json version is not usable in a folder name: ${JSON.stringify(version)}`);
if (!safeName.test(arch)) fail(`unsupported arch: ${JSON.stringify(arch)}`);

const folderName = `${productName}_${version}_${arch}`;
const exeName = `${crateName}.exe`;
const exeSource = path.join(releaseDir, exeName);

try {
  await stat(exeSource);
} catch {
  fail(`${exeSource} is missing — run \`tauri build\` (or \`pnpm tauri:build\`) first`);
}

const target = path.join(outRoot, folderName);

// A fresh folder every run: an old executable or a dictionary that was dropped from
// resources must not survive into the distribution.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(exeSource, path.join(target, exeName));

// locales/ next to the exe is where the app reads user dictionaries from; the embedded
// copies are only a fallback, so a missing folder is worth a warning, not a failure.
const localesSource = path.join(releaseDir, 'locales');
let dictionaries = [];
try {
  dictionaries = (await readdir(localesSource)).filter((name) => name.toLowerCase().endsWith('.json'));
  await cp(localesSource, path.join(target, 'locales'), { recursive: true });
} catch {
  dictionaries = [];
}

const { size } = await stat(path.join(target, exeName));
const relative = (from) => path.relative(repoRoot, from).replaceAll('\\', '/');
console.log(`portable: ${relative(path.join(target, exeName))} (${(size / 1024 / 1024).toFixed(1)} MB)`);
if (dictionaries.length > 0) {
  console.log(`portable: locales/ — ${dictionaries.sort().join(', ')}`);
} else {
  console.warn(
    `make-portable: no locales/*.json in ${localesSource} — the embedded dictionaries will be used`,
  );
}
console.log(`portable: ready — ${relative(target)}`);

// Leftovers of the installer era: harmless, but they are not updated any more and may
// be mistaken for fresh builds.
if (
  await stat(path.join(releaseDir, 'bundle')).then(
    () => true,
    () => false,
  )
) {
  console.warn(
    `make-portable: ${relative(path.join(releaseDir, 'bundle'))} holds installers built before this change — nothing regenerates them`,
  );
}
