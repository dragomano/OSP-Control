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
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
  if (!(await stat(exeSource)).isFile()) fail(`${exeSource} is not a file`);
} catch {
  fail(`${exeSource} is missing — run \`tauri build\` (or \`pnpm tauri:build\`) first`);
}

let target = path.join(outRoot, folderName);
let staging;
let canonicalOutRoot;
const busyCodes = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const removeOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 150 };
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
const checkedOutput = (file) => {
  if (!inside(canonicalOutRoot, path.resolve(file))) throw new Error(`path outside output root: ${file}`);
  return file;
};
const removeOutput = async (file) => {
  if (path.relative(target, file) === '') throw new Error(`refusing to remove the portable root: ${file}`);
  await rm(checkedOutput(file), removeOptions);
};
const retry = async (operation) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!busyCodes.has(error.code) || attempt >= 5) throw error;
      await delay(150 * (attempt + 1));
    }
  }
};

// Keep directory identities: Windows prevents deleting a process's current directory.
// Prepared files replace their predecessors atomically; removed resources are pruned.
const publish = async (source, destination) => {
  const metadata = await lstat(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
    throw new Error(`output directory is not a regular directory: ${destination}`);
  }
  await mkdir(checkedOutput(destination), { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  // Detect a locked executable before changing dictionaries or removing stale files.
  entries.sort((a, b) => Number(b.name === exeName) - Number(a.name === exeName));
  for (const entry of entries) {
    const from = checkedOutput(path.join(source, entry.name));
    const to = checkedOutput(path.join(destination, entry.name));
    if (entry.isDirectory()) await publish(from, to);
    else if (entry.isFile()) await retry(() => rename(from, to));
    else throw new Error(`unsupported staged entry: ${from}`);
  }
  const expected = new Set(entries.map((entry) => entry.name));
  for (const name of await readdir(destination)) {
    if (!expected.has(name)) await removeOutput(path.join(destination, name));
  }
};

const localesSource = path.join(releaseDir, 'locales');
let dictionaries = [];
try {
  await mkdir(outRoot, { recursive: true });
  canonicalOutRoot = await realpath(outRoot);
  target = path.join(canonicalOutRoot, folderName);
  const canonicalRelease = await realpath(releaseDir);
  if (
    path.relative(canonicalRelease, target) === '' ||
    inside(target, canonicalRelease) ||
    inside(target, await realpath(exeSource))
  ) {
    throw new Error(`release directory overlaps portable output: ${releaseDir}`);
  }
  staging = await mkdtemp(path.join(canonicalOutRoot, `.${folderName}.staging-`));
  await cp(exeSource, path.join(staging, exeName));
  let hasLocales = true;
  try {
    dictionaries = (await readdir(localesSource)).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    hasLocales = false;
  }
  if (hasLocales) await cp(localesSource, path.join(staging, 'locales'), { recursive: true });
  await publish(staging, target);
  await removeOutput(staging);
  staging = undefined;
} catch (error) {
  if (staging) {
    await removeOutput(staging).catch((cleanupError) => {
      console.warn(`make-portable: cannot clean temporary folder ${staging}: ${cleanupError.message}`);
    });
  }
  const hint = busyCodes.has(error.code)
    ? ' Close the portable application and programs holding its files; check write permissions, then rerun this script.'
    : '';
  fail(
    `cannot assemble ${target}: ${error.message}.${hint} The compiled executable is available at ${exeSource}.`,
  );
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
