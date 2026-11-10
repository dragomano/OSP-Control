import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it('separates test declarations from the preceding closed block with a blank line', () => {
  const failures: string[] = [];
  for (const file of testFiles('tests')) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 1; index < lines.length; index++) {
      if (!/^\s*(?:it|test)(?:\s*\(|\.)/.test(lines[index])) continue;
      let previous = index - 1;
      // Explanatory comments belong to the following test; require spacing before them too.
      while (previous >= 0) {
        if (/^\s*\/\//.test(lines[previous])) previous--;
        else if (/\*\/\s*$/.test(lines[previous])) {
          while (previous >= 0 && !lines[previous].includes('/*')) previous--;
          previous--;
        } else break;
      }
      if (previous >= 0 && /^\s*(?:\}\);|\);)\s*$/.test(lines[previous])) {
        failures.push(`${file}:${index + 1}`);
      }
    }
  }
  expect(failures).toEqual([]);
});
