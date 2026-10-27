import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseNotes } from '../src/components/widgets/ReleaseNotes';

const { openInBrowser } = vi.hoisted(() => ({ openInBrowser: vi.fn() }));
vi.mock('../src/ospanel', () => ({ openInBrowser }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('renders GitHub release formatting, plain URLs, tables, tasks and code', () => {
  const { container } = render(
    <ReleaseNotes
      onLinkError={vi.fn()}
      notes={
        "### What's new\n\n- **Updates** and *fixes*\n- ~~Old~~ `code`\n\n**Full Changelog**: https://github.com/dragomano/OSP-Control/compare/v0.2.0...v0.3.0\n\n> Note\n\n```sh\npnpm build\n```\n\n| Module | Status |\n| --- | --- |\n| PHP | Updated |\n\n- [x] Done"
      }
    />,
  );
  expect(screen.getByRole('heading', { name: "What's new", level: 3 })).toBeVisible();
  expect(container.querySelector('strong')).toHaveTextContent('Updates');
  expect(container.querySelector('em')).toHaveTextContent('fixes');
  expect(container.querySelector('del')).toHaveTextContent('Old');
  expect(container.querySelector('pre code')).toHaveTextContent('pnpm build');
  expect(screen.getByRole('table')).toHaveTextContent('PHP');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    'https://github.com/dragomano/OSP-Control/compare/v0.2.0...v0.3.0',
  );
});

it('does not execute HTML, render remote images or allow unsafe link protocols', () => {
  const { container } = render(
    <ReleaseNotes
      onLinkError={vi.fn()}
      notes={
        '<script>alert(1)</script>\n\n<img src="https://example.com/track" onerror="alert(1)">\n\n![Screenshot](https://example.com/image.png)\n\n[Unsafe](javascript:alert%281%29) [File](file:///C:/Windows) [Data](data:text/html,unsafe)'
      }
    />,
  );
  expect(container.querySelector('script, img, iframe')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Screenshot')).toBeVisible();
  expect(screen.getByText('Unsafe')).toBeVisible();
});

it('opens repository-relative links in the system browser and reports failures', async () => {
  const onLinkError = vi.fn();
  const error = new Error('err.popupBlocked');
  openInBrowser.mockRejectedValue(error);
  render(<ReleaseNotes notes="[Changes](compare/v0.2.0...v0.3.0)" onLinkError={onLinkError} />);
  fireEvent.click(screen.getByRole('link', { name: 'Changes' }));
  expect(openInBrowser).toHaveBeenCalledWith(
    'https://github.com/dragomano/OSP-Control/compare/v0.2.0...v0.3.0',
  );
  await vi.waitFor(() => expect(onLinkError).toHaveBeenCalledWith(error));
});
