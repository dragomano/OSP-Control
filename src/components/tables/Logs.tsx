import { ChevronRight, Copy, RefreshCw, Search, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { LogSource } from '../../ospanel';
import { type ActivityEntry, copyText, type Notify } from '../shared';
import { PageHeader } from '../widgets/PageHeader';
import { RowMenu } from '../widgets/RowMenu';

type LogLevel = 'error' | 'warning' | 'info';
export type LogAliases = Record<LogLevel, string[]>;

// These markers are machine-oriented and remain valid for third-party module logs.
const MACHINE_ALIASES: LogAliases = {
  error: ['error', 'errors', 'err', 'fatal', 'failed', 'failure', 'exception', 'critical'],
  warning: ['warn', 'warning', 'warnings', 'deprecated', 'notice'],
  info: ['info', 'information'],
};

export function logAliasesFromTranslator(t: (key: string) => string): LogAliases {
  const aliases = (key: string) =>
    t(key)
      .split('|')
      .map((value) => value.trim())
      .filter(Boolean);
  return {
    error: [...MACHINE_ALIASES.error, ...aliases('logs.level.errorAliases')],
    warning: [...MACHINE_ALIASES.warning, ...aliases('logs.level.warningAliases')],
    info: [...MACHINE_ALIASES.info, ...aliases('logs.level.infoAliases')],
  };
}

const normalizeSeverityToken = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[«»"'`]/g, '')
    .trim();

const severityFromToken = (value: string, aliases: LogAliases): LogLevel | undefined => {
  const token = normalizeSeverityToken(value);

  for (const level of ['error', 'warning', 'info'] as const) {
    if (aliases[level].some((alias) => normalizeSeverityToken(alias) === token)) return level;
  }

  return undefined;
};

// Structured levels are preferred over prose: a warning block may contain fields such as
// "error code: 1" without becoming an error itself.
const structuredSeverity = (line: string, aliases: LogAliases): LogLevel | undefined => {
  const jsonLevel = /["'](?:level|severity)["']\s*:\s*["']([^"']+)["']/i.exec(line)?.[1];
  const keyLevel = /(?:^|[\s,;{[])(?:level|severity)\s*[:=]\s*([\w-]+)/i.exec(line)?.[1];
  const bracketLevel = /^\s*\[\s*([^\]]+)\s*\]/.exec(line)?.[1];

  return [jsonLevel, keyLevel, bracketLevel]
    .map((value) => (value ? severityFromToken(value, aliases) : undefined))
    .find((level): level is LogLevel => level !== undefined);
};

const proseSeverity = (line: string, aliases: LogAliases): LogLevel => {
  const tokens = line
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const level of ['error', 'warning', 'info'] as const) {
    if (tokens.some((token) => aliases[level].some((alias) => normalizeSeverityToken(alias) === token)))
      return level;
  }

  return 'info';
};

const logLevelOf = (line: string, aliases: LogAliases): LogLevel =>
  structuredSeverity(line, aliases) ?? proseSeverity(line, aliases);

const isLogBlockMarker = (value: string, aliases: LogAliases): boolean =>
  Boolean(severityFromToken(value.replace(/\s*:\s*$/, ''), aliases));

const logMarkerLevel = (mark: string, aliases: LogAliases): LogLevel =>
  severityFromToken(mark, aliases) ?? 'info';

// A frame line: dashes and box-drawing characters the panel wraps error blocks in.
const isLogFrame = (text: string): boolean =>
  /^[\s+|—–\-=_*\u2500-\u257F]+$/.test(text) && /[+|—–\-=_*\u2500-\u257F]/.test(text);

// Log tail → events for "Recent activity": frames are dropped, neighboring lines of a
// block ("| ERROR", "| Message: …", "| Reason: …") are merged into a single entry.
export const buildActivityRows = (
  lines: string[],
  aliases: LogAliases = MACHINE_ALIASES,
): ActivityEntry[] => {
  const rows: ActivityEntry[] = [];
  let block: { time: string; mark: string; parts: string[] } | null = null;
  const flush = () => {
    if (!block) return;

    const subject = block.parts.find((p) => /^(модуль|module)\s*:/i.test(p));
    // "Module: Nginx (default)" moves to the start of the entry and is dropped from the
    // message body — otherwise it would resurface in the fallback block.parts[0].
    const body = block.parts.filter((p) => p !== subject);
    const headline = body.find((p) => /^(сообщение|message)\s*:/i.test(p));
    const reason = body.find((p) => /^(причина|reason)\s*:/i.test(p));

    const text =
      (headline ?? body[0] ?? '').replace(/^(сообщение|message|причина|reason)\s*:\s*/i, '') || block.mark;
    const detail = reason && reason !== headline ? reason.replace(/^(причина|reason)\s*:\s*/i, '') : '';
    const prefix = subject ? subject.replace(/^(модуль|module)\s*:\s*/i, '') : '';
    const merged = detail ? `${text} — ${detail}` : text;

    rows.push({
      level: block.mark ? logMarkerLevel(block.mark, aliases) : logLevelOf(block.parts.join(' '), aliases),
      time: block.time,
      text: prefix ? `${prefix} — ${merged}` : merged,
    });
    block = null;
  };

  for (const line of lines) {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    const time = match?.[1] ?? '';
    const text = (match?.[2] ?? line).trim();

    if (!text) continue;
    if (isLogFrame(text)) {
      // An inner frame "|——" continues the block, an outer "+——" closes it. Without
      // closing, neighboring panel blocks merged into one event and the last block's
      // marker overwrote the previous one — a warning marker leaked into the errors tab.
      if (!text.startsWith('|')) flush();
      continue;
    }

    if (text.startsWith('|')) {
      const content = text.replace(/^\|\s*/, '');
      if (content) {
        block ??= { time, mark: '', parts: [] };
        if (isLogBlockMarker(content, aliases)) block.mark = content;
        else block.parts.push(content);
      }
      continue;
    }
    flush();
    rows.push({ level: logLevelOf(text, aliases), time, text });
  }

  flush();
  return rows;
};

export function Logs({
  notify,
  sources,
  source,
  onSourceChange,
  lines,
  auto,
  onAutoChange,
}: {
  notify: Notify;
  sources: LogSource[];
  source: string;
  onSourceChange: (source: string) => void;
  lines: string[];
  auto: boolean;
  onAutoChange: (auto: boolean) => void;
}) {
  const { t } = useI18n();
  const aliases = useMemo(() => logAliasesFromTranslator(t), [t]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'all' | 'error' | 'warning'>('all');
  // Level tabs show merged events: in an error block the marker, the message
  // and the reason become one entry with a detail, not a bare "ERROR" line.
  const events = useMemo(() => buildActivityRows(lines, aliases), [aliases, lines]);
  const counts = useMemo(
    () => ({
      error: events.filter((event) => event.level === 'error').length,
      warning: events.filter((event) => event.level === 'warning').length,
    }),
    [events],
  );
  // "All events" — the raw log as is; on the level tabs, events are filtered.
  const rawVisible = useMemo(
    () => lines.filter((line) => line.toLowerCase().includes(query.toLowerCase())),
    [lines, query],
  );
  const levelVisible = useMemo(() => {
    const needle = query.toLowerCase();
    return events.filter(
      (event) =>
        event.level === level && (event.text.toLowerCase().includes(needle) || event.time.includes(needle)),
    );
  }, [events, level, query]);
  // Domain log labels come without the prefix — it is translated via logs.sourceDomain.
  const sourceLabel = (item: LogSource) =>
    item.domain ? t('logs.sourceDomain', { name: item.label }) : item.label;
  const activeSource = sources.find((item) => item.name === source);
  // The rows of the active tab: raw tail lines on "All events", merged events on the level tabs.
  const rendered =
    level === 'all'
      ? rawVisible.map((line, index) => {
          const lineLevel = logLevelOf(line, aliases);
          const match = line.match(/^\[([^\]]+)\]\s*/);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: log tail lines repeat — the position in the window is the only stable and unique key
            <div className={`log-line ${lineLevel}`} key={index}>
              <span>{match ? match[1] : ''}</span>
              <code>{match ? line.slice(match[0].length) : line}</code>
            </div>
          );
        })
      : levelVisible.map((event) => (
          <div className={`log-line ${event.level}`} key={`${event.time}-${event.text}`}>
            <span>{event.time}</span>
            <code>{event.text}</code>
          </div>
        ));

  return (
    <>
      <PageHeader
        eyebrow={t('nav.workspace')}
        heading={t('logs.pageTitle')}
        description={t('logs.subtitle')}
        action={
          <button
            type="button"
            className={`secondary-button ${auto ? 'on' : ''}`}
            onClick={() => onAutoChange(!auto)}
          >
            <RefreshCw size={15} />
            {t('logs.autorefresh')}
          </button>
        }
      />
      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('logs.searchPlaceholder')}
          />
        </div>
        <RowMenu
          trigger={({ onToggle, open }) => (
            <button
              type="button"
              className="filter-button"
              onClick={onToggle}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              <Terminal size={15} />
              {activeSource ? sourceLabel(activeSource) : source}
              <ChevronRight size={14} />
            </button>
          )}
          entries={sources.map((item) => ({
            label: sourceLabel(item),
            icon: Terminal,
            onSelect: () => onSourceChange(item.name),
          }))}
        />
      </div>
      <div className="log-panel">
        <div className="log-tabs">
          <button
            type="button"
            className={`log-tab ${level === 'all' ? 'active' : ''}`}
            onClick={() => setLevel('all')}
          >
            {t('logs.tabAll')}
          </button>
          <button
            type="button"
            className={`log-tab ${level === 'error' ? 'active' : ''}`}
            onClick={() => setLevel('error')}
          >
            {t('logs.tabErrors')} <em>{counts.error}</em>
          </button>
          <button
            type="button"
            className={`log-tab ${level === 'warning' ? 'active' : ''}`}
            onClick={() => setLevel('warning')}
          >
            {t('logs.tabWarnings')} <em className="orange">{counts.warning}</em>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('logs.copyAria')}
            onClick={() =>
              void copyText(
                t,
                level === 'all'
                  ? rawVisible.join('\n')
                  : levelVisible.map((event) => `[${event.time}] ${event.text}`).join('\n'),
                'label.log',
                notify,
              )
            }
          >
            <Copy size={15} />
          </button>
        </div>
        <div className="log-content">
          {rendered.length > 0 ? rendered : <div className="empty-note">{t('logs.empty')}</div>}
        </div>
      </div>
    </>
  );
}
