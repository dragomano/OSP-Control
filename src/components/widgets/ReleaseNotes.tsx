import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openInBrowser } from '../../ospanel';

const repository = 'https://github.com/dragomano/OSP-Control/';

// Release links are repository-relative on GitHub; never resolve them against the desktop origin.
function releaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value, repository);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    // Invalid destinations remain readable text, not interactive links.
  }
  return undefined;
}

export function ReleaseNotes({
  notes,
  onLinkError,
}: {
  notes: string;
  onLinkError: (error: unknown) => void;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url, key) => (key === 'href' ? releaseUrl(url) : undefined)}
      components={{
        a: ({ href, children }) =>
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void openInBrowser(href).catch(onLinkError);
              }}
            >
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        // Avoid remote tracking and oversized media in release descriptions.
        img: ({ alt }) => <span>{alt}</span>,
        table: ({ children }) => (
          <div className="app-update-table">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {notes}
    </Markdown>
  );
}
