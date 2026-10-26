import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

// The script runs as a real CLI in a child process, with the release directory and the
// output root passed as arguments: importing it would assemble the distribution into
// the repository. Fixtures are disposable folders in a temp directory.
const runScript = promisify(execFile);

const script = path.resolve(process.cwd(), 'scripts/make-portable.mjs');
const { version } = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
  version: string;
};
const conf = JSON.parse(readFileSync(path.resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')) as {
  productName: string;
};

// The executable carries the Cargo package name, not productName.
const manifest = readFileSync(path.resolve(process.cwd(), 'src-tauri/Cargo.toml'), 'utf8');
const crateName = manifest
  .slice(manifest.indexOf('[package]'), manifest.indexOf('\n['))
  .match(/^name\s*=\s*"([^"]+)"/m)?.[1];
if (!crateName) throw new Error('cannot read [package] name from src-tauri/Cargo.toml');
const exeName = `${crateName}.exe`;

const archTokens: Record<string, string> = { x64: 'x64', arm64: 'arm64', ia32: 'x86' };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

// A throwaway copy of what `tauri build` leaves in target/release: the executable and
// the locales folder tauri-build copies next to it.
const workspace = async (files: string[] = [exeName, 'locales/en.json', 'locales/ru.json']) => {
  const root = await mkdtemp(path.join(tmpdir(), 'make-portable-'));
  roots.push(root);
  const release = path.join(root, 'release');
  const out = path.join(root, 'dist-portable');
  for (const name of files) {
    const file = path.join(release, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `stub:${name}`);
  }
  return { root, release, out };
};

const makePortable = (args: string[]) => runScript(process.execPath, [script, ...args]);

// A failing run is expected in several fixtures: hand back its status and stderr.
const failure = async (args: string[]) => {
  try {
    await makePortable(args);
  } catch (error) {
    return error as { code?: number; stderr?: string };
  }
  throw new Error('the script was expected to fail');
};

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

// Keep a real Windows directory/image lock without touching any user process.
const withHeldDirectory = async (
  cwd: string,
  action: (release: () => Promise<void>) => Promise<void>,
  executable = process.execPath,
) => {
  const child = spawn(executable, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const release = async () => {
    child.kill();
    await closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Lock fixture exited before becoming ready')));
      child.stdout.once('data', () => resolve());
    });
    await action(release);
  } finally {
    await release();
  }
};

describe('make-portable.mjs', () => {
  it('assembles the portable folder: the executable plus the editable dictionaries', async () => {
    const { release, out } = await workspace();

    const { stdout } = await makePortable([release, out, 'arm64']);

    const folder = path.join(out, `OSP_Control_${version}_arm64`);
    expect((await readdir(folder)).sort()).toEqual(['locales', exeName].sort());
    expect(await readFile(path.join(folder, exeName), 'utf8')).toBe(`stub:${exeName}`);
    expect((await readdir(path.join(folder, 'locales'))).sort()).toEqual(['en.json', 'ru.json']);
    expect(stdout).toContain(`OSP_Control_${version}_arm64/${exeName}`);
    expect(stdout).toContain('portable: ready');
  });

  it('names the folder after productName with spaces replaced by underscores', async () => {
    const { release, out } = await workspace();

    await makePortable([release, out, 'x64']);

    expect(conf.productName).toContain(' ');
    expect(await readdir(out)).toEqual([`OSP_Control_${version}_x64`]);
  });

  it('defaults to the host architecture', async () => {
    const { release, out } = await workspace();

    await makePortable([release, out]);

    const expected = archTokens[process.arch] ?? process.arch;
    expect(await readdir(out)).toEqual([`OSP_Control_${version}_${expected}`]);
  });

  it('refreshes files and removes resources dropped from an earlier build', async () => {
    const { release, out } = await workspace();
    const stale = path.join(out, `OSP_Control_${version}_x64`);
    await mkdir(path.join(stale, 'locales'), { recursive: true });
    await writeFile(path.join(stale, 'notes.txt'), 'stale');
    await writeFile(path.join(stale, 'locales', 'xx.json'), '{}');

    await makePortable([release, out, 'x64']);

    expect((await readdir(stale)).sort()).toEqual(['locales', exeName].sort());
    expect((await readdir(path.join(stale, 'locales'))).sort()).toEqual(['en.json', 'ru.json']);
  });

  it('warns about missing dictionaries but still assembles the folder', async () => {
    const { release, out } = await workspace([exeName]);

    const { stdout, stderr } = await makePortable([release, out, 'x64']);

    const folder = path.join(out, `OSP_Control_${version}_x64`);
    expect(await readdir(folder)).toEqual([exeName]);
    expect(stderr).toContain('locales');
    expect(stdout).toContain('portable: ready');
  });

  it('fails without assembling anything when the executable was not built', async () => {
    const { release, out } = await workspace(['locales/en.json']);

    const error = await failure([release, out, 'x64']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('tauri build');
    expect(await exists(out)).toBe(false);
  });

  it('refuses an arch that would escape the output folder', async () => {
    const { root, release, out } = await workspace();

    const error = await failure([release, out, '..\\..\\evil']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('unsupported arch');
    expect(await readdir(root)).toEqual(['release']);
  });

  for (const workingDirectory of ['', 'locales']) {
    it.runIf(process.platform === 'win32')(
      `rebuilds while a process uses ${workingDirectory || 'the portable root'} as its current directory`,
      async () => {
        const { release, out } = await workspace();
        const folder = path.join(out, `OSP_Control_${version}_x64`);
        await mkdir(path.join(folder, 'locales'), { recursive: true });
        await writeFile(path.join(folder, exeName), 'old executable');
        await writeFile(path.join(folder, 'locales', 'xx.json'), '{}');
        await withHeldDirectory(path.join(folder, workingDirectory), async () => {
          const { stdout } = await makePortable([release, out, 'x64']);
          expect(stdout).toContain('portable: ready');
          expect(await readFile(path.join(folder, exeName), 'utf8')).toBe(`stub:${exeName}`);
          expect((await readdir(path.join(folder, 'locales'))).sort()).toEqual(['en.json', 'ru.json']);
          expect(await readdir(out)).toEqual([path.basename(folder)]);
        });
      },
    );
  }

  it.runIf(process.platform === 'win32')(
    'reports a persistently locked executable and leaves the earlier build intact',
    async () => {
      const { release, out } = await workspace();
      const folder = path.join(out, `OSP_Control_${version}_x64`);
      await mkdir(path.join(folder, 'locales'), { recursive: true });
      const executable = path.join(folder, exeName);
      await copyFile(process.execPath, executable);
      const previousSize = (await stat(executable)).size;
      await writeFile(path.join(folder, 'locales', 'ru.json'), 'previous dictionary');
      await withHeldDirectory(
        folder,
        async () => {
          const error = await failure([release, out, 'x64']);
          expect(error.code).toBe(1);
          expect(error.stderr).toContain('Close the portable application');
          expect(error.stderr).toContain(path.join(release, exeName));
          expect((await stat(executable)).size).toBe(previousSize);
          expect(await readFile(path.join(folder, 'locales', 'ru.json'), 'utf8')).toBe('previous dictionary');
          expect(await readdir(out)).toEqual([path.basename(folder)]);
        },
        executable,
      );
    },
    15000,
  );

  it.runIf(process.platform === 'win32')(
    'retries an executable lock released during packaging',
    async () => {
      const { release, out } = await workspace();
      const folder = path.join(out, `OSP_Control_${version}_x64`);
      await mkdir(folder, { recursive: true });
      const executable = path.join(folder, exeName);
      await copyFile(process.execPath, executable);
      await withHeldDirectory(
        folder,
        async (unlock) => {
          const timer = setTimeout(() => void unlock(), 400);
          try {
            const { stdout } = await makePortable([release, out, 'x64']);
            expect(stdout).toContain('portable: ready');
            expect(await readFile(executable, 'utf8')).toBe(`stub:${exeName}`);
          } finally {
            clearTimeout(timer);
          }
        },
        executable,
      );
    },
    15000,
  );

  it('fails on unreadable locale sources without modifying an earlier distribution', async () => {
    const { release, out } = await workspace([exeName, 'locales']);
    const folder = path.join(out, `OSP_Control_${version}_x64`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, exeName), 'previous executable');
    const error = await failure([release, out, 'x64']);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain('cannot assemble');
    expect(await readFile(path.join(folder, exeName), 'utf8')).toBe('previous executable');
    expect(await readdir(out)).toEqual([path.basename(folder)]);
  });

  it('refuses to assemble over the release directory itself', async () => {
    const { root, release } = await workspace();
    const folderName = `OSP_Control_${version}_x64`;
    const nestedRelease = path.join(root, folderName);
    await mkdir(nestedRelease, { recursive: true });
    await copyFile(path.join(release, exeName), path.join(nestedRelease, exeName));
    const error = await failure([nestedRelease, root, 'x64']);
    expect(error.stderr).toContain('overlaps portable output');
    expect(await readFile(path.join(nestedRelease, exeName), 'utf8')).toBe(`stub:${exeName}`);
  });
});
