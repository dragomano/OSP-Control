import { lexer, type Token, type Tokens } from 'marked';
import { createElement, Fragment, type ReactNode } from 'react';
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

function renderInline(
  tokens: readonly Token[] | undefined,
  onLinkError: (error: unknown) => void,
): ReactNode {
  if (!tokens) return null;
  return tokens.map((token, index) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: Markdown tokens form a fixed sequence — position is the only stable key.
    return <Fragment key={index}>{renderToken(token, onLinkError)}</Fragment>;
  });
}

// Render Markdown as React elements so text is escaped by React (no raw HTML,
// no XSS). Raw HTML appears as an escaped literal; tables and task-list
// checkboxes are supported. Link definitions are skipped.
function renderToken(token: Token, onLinkError: (error: unknown) => void): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'heading':
      return createElement(`h${token.depth}`, null, renderInline(token.tokens, onLinkError));
    case 'paragraph':
      return <p>{renderInline(token.tokens, onLinkError)}</p>;
    case 'blockquote':
      return <blockquote>{renderInline(token.tokens, onLinkError)}</blockquote>;
    case 'list': {
      const { items, ordered } = token as Tokens.List;
      const ListTag = ordered ? 'ol' : 'ul';
      return (
        <ListTag>
          {items.map((item, index) => {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items keep their source order — index is the only stable key.
              <li key={index}>
                {item.task && <input type="checkbox" checked={item.checked} disabled />}
                {renderInline(item.tokens, onLinkError)}
              </li>
            );
          })}
        </ListTag>
      );
    }
    case 'code':
      return (
        <pre>
          <code>{token.text}</code>
        </pre>
      );
    case 'codespan':
      return <code>{token.text}</code>;
    case 'text':
      return token.tokens && token.tokens.length > 0 ? renderInline(token.tokens, onLinkError) : token.text;
    case 'escape':
      return token.text;
    case 'strong':
      return <strong>{renderInline(token.tokens, onLinkError)}</strong>;
    case 'em':
      return <em>{renderInline(token.tokens, onLinkError)}</em>;
    case 'del':
      return <del>{renderInline(token.tokens, onLinkError)}</del>;
    case 'link': {
      const href = releaseUrl(token.href);
      if (!href) return <span>{renderInline(token.tokens, onLinkError)}</span>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void openInBrowser(href).catch(onLinkError);
          }}
        >
          {renderInline(token.tokens, onLinkError)}
        </a>
      );
    }
    case 'image':
      // Avoid remote tracking and oversized media in release descriptions.
      return <span>{renderInline(token.tokens, onLinkError)}</span>;
    case 'table': {
      const { header, rows } = token as Tokens.Table;
      return (
        <div className="app-update-table">
          <table>
            <thead>
              <tr>
                {header.map((cell, index) => {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table columns keep their source order — index is the only stable key.
                    <th key={index}>{renderInline(cell.tokens, onLinkError)}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table rows keep their source order — index is the only stable key.
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => {
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: table columns keep their source order — index is the only stable key.
                        <td key={cellIndex}>{renderInline(cell.tokens, onLinkError)}</td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }
    case 'br':
      return <br />;
    case 'hr':
      return <hr />;
    case 'html':
      // Render raw HTML as an escaped literal so it is never interpreted.
      return token.text;
    default:
      // Skip link definitions — unused in release notes.
      return null;
  }
}

export function ReleaseNotes({
  notes,
  onLinkError,
}: {
  notes: string;
  onLinkError: (error: unknown) => void;
}) {
  return (
    <>
      {lexer(notes).map((token, index) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: Markdown tokens form a fixed sequence — position is the only stable key.
        return <Fragment key={index}>{renderToken(token, onLinkError)}</Fragment>;
      })}
    </>
  );
}
