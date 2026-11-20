import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectFavicon } from '../src/components/widgets/ProjectFavicon';

afterEach(cleanup);

describe('ProjectFavicon', () => {
  it('requests the site icon from the project server', () => {
    const { container } = render(<ProjectFavicon domain="icon-site.test" />);

    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://icon-site.test/favicon.ico');
  });

  it('retries over HTTPS when plain HTTP does not answer', () => {
    const { container } = render(<ProjectFavicon domain="tls-only.test" />);

    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://tls-only.test/favicon.ico');
  });

  it('does not wait for a silent host and moves on to the next scheme on a timer', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ProjectFavicon domain="silent-site.test" />);

      act(() => vi.advanceTimersByTime(1500));

      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://silent-site.test/favicon.ico',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces an unreachable icon with the globe fallback', () => {
    const { container } = render(<ProjectFavicon domain="no-icon.test" />);

    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.project-favicon-fallback')).not.toBeNull();
  });

  it('retries a failed icon when the window regains focus', () => {
    const { container } = render(<ProjectFavicon domain="late-panel.test" />);

    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    fireEvent.focus(window);

    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://late-panel.test/favicon.ico');
  });
});
