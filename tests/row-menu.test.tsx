import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowMenu } from '../src/components/widgets/RowMenu';

const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
let anchor: DOMRect;
const viewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

beforeEach(() => {
  viewport(498, 600);
  anchor = new DOMRect(420, 200, 41.6, 41.6);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('row-menu') ? anchor : new DOMRect();
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('row-menu') ? 32 : 240;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(440);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(438);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(650);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
  if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight);
});

function expectInsideViewport(menu: HTMLElement) {
  const zoom = 1.3;
  const left = Number.parseFloat(menu.style.left) * zoom;
  const top = Number.parseFloat(menu.style.top) * zoom;
  expect(left).toBeGreaterThanOrEqual(7.99);
  expect(top).toBeGreaterThanOrEqual(7.99);
  expect(left + Number.parseFloat(menu.style.maxWidth) * zoom).toBeLessThanOrEqual(window.innerWidth - 7.99);
  expect(top + Number.parseFloat(menu.style.maxHeight) * zoom).toBeLessThanOrEqual(window.innerHeight - 7.99);
}

describe('action menu placement', () => {
  it('keeps a tall menu inside a narrow viewport at 130% interface scale', () => {
    render(<RowMenu entries={[{ label: 'Open folder', onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button'));
    expectInsideViewport(screen.getByRole('menu'));
  });

  it('repositions an open menu after resizing and keeps expandable commands available', () => {
    render(<RowMenu entries={[{ label: 'Open in', children: [{ label: 'Editor', onSelect: vi.fn() }] }]} />);
    fireEvent.click(screen.getByRole('button'));
    const menu = screen.getByRole('menu');
    viewport(320, 240);
    anchor = new DOMRect(250, 150, 41.6, 41.6);
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('menu')).toBe(menu);
    expectInsideViewport(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in' }));
    expect(screen.getByRole('menuitem', { name: 'Editor' })).toBeInTheDocument();
    expectInsideViewport(menu);
  });
});
