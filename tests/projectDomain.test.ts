import { describe, expect, it } from 'vitest';
import { displayProjectDomain, normalizeProjectDomain } from '../src/projectDomain';

describe('project domain display', () => {
  it.each([
    ['shop.test', 'shop.test'],
    ['café.test', 'café.test'],
    ['xn--caf-dma.test', 'café.test'],
    ['XN--CAF-DMA.TEST', 'café.test'],
    ['sub.xn--80aae1b9a9d.xn--p1ai.test', 'sub.\u0432\u0430\u043b\u044e\u0442\u0430.\u0440\u0444.test'],
  ])('displays %s as %s', (domain, expected) => {
    expect(displayProjectDomain(domain)).toBe(expected);
  });

  it.each(['', 'xn--.test', 'xn--a.test', 'xn--caf-dma.test/path'])(
    'preserves invalid input %s',
    (domain) => {
      expect(displayProjectDomain(domain)).toBe(domain);
    },
  );
});

describe('project domain normalization', () => {
  it.each([
    [' Shop.TEST ', 'shop.test'],
    ['my_app.test', 'my_app.test'],
    ['café.test', 'xn--caf-dma.test'],
    ['CAFE\u0301.TEST', 'xn--caf-dma.test'],
    ['XN--CAF-DMA.TEST', 'xn--caf-dma.test'],
    ['\u0432\u0430\u043b\u044e\u0442\u0430.test', 'xn--80aae1b9a9d.test'],
    ['\u0432\u0430\u043b\u044e\u0442\u0430.\u0440\u0444.test', 'xn--80aae1b9a9d.xn--p1ai.test'],
    ['café\u3002test', 'xn--caf-dma.test'],
    ['123', '123'],
    [`${'a'.repeat(63)}.test`, `${'a'.repeat(63)}.test`],
    [`${Array(4).fill('a'.repeat(60)).join('.')}.test`, `${Array(4).fill('a'.repeat(60)).join('.')}.test`],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeProjectDomain(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '../escape',
    '..\\escape',
    'bad/name.test',
    'https://café.test',
    'user@café.test',
    'café.test:80',
    'café.test?query',
    'café.test#fragment',
    'caf%65.test',
    'caf\té.test',
    'bad name.test',
    'café..test',
    '.café.test',
    'café.test.',
    '-bad.test',
    'bad-.test',
    'xn--.test',
    'xn--a.test',
    'CON.test',
    'lpt1.test',
    'bad\u200d.test',
    '\ud800.test',
    `${'a'.repeat(64)}.test`,
    `${'é'.repeat(58)}.test`,
    `${Array(4).fill('a'.repeat(63)).join('.')}.test`,
  ])('rejects unsafe or invalid input %s', (input) => {
    expect(normalizeProjectDomain(input)).toBeNull();
  });
});
