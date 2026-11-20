import { useCallback, useEffect, useMemo, useState } from 'react';

const FAVICON_TIMEOUT_MS = 1500;

// Working candidates are remembered so filtering or sorting does not flash the
// fallback while the WebView re-reads an icon it has already cached.
const loadedIndexes = new Map<string, number>();

function faviconUrls(domain: string): string[] {
  // Plain HTTP goes first: OSPanel serves every project over it even when TLS is enabled.
  return [`http://${domain}/favicon.ico`, `https://${domain}/favicon.ico`];
}

export function ProjectFavicon({ domain }: { domain: string }) {
  const urls = useMemo(() => faviconUrls(domain), [domain]);
  const [state, setState] = useState(() => ({
    index: Math.min(loadedIndexes.get(domain) ?? 0, urls.length),
    loaded: false,
  }));
  const src = state.index < urls.length ? urls[state.index] : null;

  const advance = useCallback(() => {
    setState((current) => ({ index: current.index + 1, loaded: false }));
  }, []);

  // An unknown host can keep a favicon request pending for many seconds, so the next
  // candidate is tried on a timer instead of waiting for the browser to give up.
  useEffect(() => {
    if (!src || state.loaded) return;
    const timer = window.setTimeout(advance, FAVICON_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, state.loaded, advance]);

  // The panel can start after the list rendered and the rows do not remount, so an
  // icon that failed once is retried when the window regains focus.
  useEffect(() => {
    if (state.index < urls.length) return;
    const retry = () => setState({ index: 0, loaded: false });
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [state.index, urls.length]);

  if (!src) return <span className="project-favicon project-favicon-fallback" aria-hidden="true" />;

  return (
    <img
      className="project-favicon"
      src={src}
      alt=""
      aria-hidden="true"
      decoding="async"
      onLoad={() => {
        loadedIndexes.set(domain, state.index);
        setState((current) => ({ ...current, loaded: true }));
      }}
      onError={advance}
    />
  );
}
