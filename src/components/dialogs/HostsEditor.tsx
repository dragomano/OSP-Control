import {
  AlertTriangle,
  Check,
  Copy,
  FileCode2,
  ListPlus,
  LockKeyhole,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { highlightHosts } from '../../highlight';
import {
  appendHostsBlock,
  changeHostsEntry,
  type HostsDocument,
  type HostsEntry,
  type HostsIssue,
  hostsBlockHasMarkers,
  hostsManagedBlocks,
  parseHosts,
  toggleHostsEntry,
  validHostsIp,
  validHostsName,
} from '../../hosts';
import { errorText, useI18n } from '../../i18n';
import { flushHostsDns, isDesktopApp, readHosts, writeHosts } from '../../ospanel';
import { copyText, type Notify, useDismiss } from '../shared';
import './hostsEditor.css';

function useHostsDialog(ref: RefObject<HTMLDivElement | null>, close: () => void, enabled = true) {
  useDismiss(ref, close, enabled);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLElement>('button, input, textarea')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [ref]);
  useEffect(() => {
    if (!enabled) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary',
        ) ?? [],
      ).filter((element) => !element.closest('[hidden]'));
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first && last) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last && first) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [ref, enabled]);
}

function Issues({ issues }: { issues: HostsIssue[] }) {
  const { t } = useI18n();
  return (
    <div className="hosts-issues" role="alert">
      {[...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).entries()]
        .slice(0, 10)
        .map(([key, issue]) => (
          <p key={key}>{t(issue.code, issue.params)}</p>
        ))}
      {issues.length > 10 && <p>{t('hosts.moreIssues', { count: issues.length - 10 })}</p>}
    </div>
  );
}

export function HostsEditor({ onClose, notify }: { onClose: () => void; notify: Notify }) {
  const { t } = useI18n();
  const [document, setDocument] = useState<HostsDocument | null>(null);
  const [content, setContent] = useState('');
  const [view, setView] = useState<'table' | 'text'>('table');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ backup: string | null; dnsFlushed: boolean } | null>(null);
  const [sheet, setSheet] = useState<'batch' | 'new' | HostsEntry | null>(null);
  const [discard, setDiscard] = useState<'close' | 'reload' | null>(null);
  const [limit, setLimit] = useState(100);
  const windowRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const pending = useRef(false);
  const request = useRef(0);
  const dirty = document !== null && document.content !== content;
  const parsed = useMemo(() => parseHosts(content), [content]);
  const highlighted = useMemo(() => (view === 'text' ? highlightHosts(content) : ''), [content, view]);
  const managedChanged = document && hostsManagedBlocks(document.content) !== hostsManagedBlocks(content);
  const blocked = loading || busy;
  const inputId = useId();
  const load = async () => {
    if (pending.current) return;
    const id = ++request.current;
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      const next = await readHosts();
      if (request.current !== id) return;
      setDocument(next);
      setContent(next.content);
      setResult(null);
      setLimit(100);
    } catch (failure) {
      if (request.current === id) setError(errorText(t, failure, 'hosts.readFailed'));
    } finally {
      if (request.current === id) {
        pending.current = false;
        setLoading(false);
      }
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    return () => {
      request.current += 1;
      pending.current = false;
    };
  }, []);
  const close = () => {
    if (!pending.current) {
      if (dirty) setDiscard('close');
      else onClose();
    }
  };
  useHostsDialog(windowRef, close, !sheet);
  const change = (next: string) => {
    setContent(next);
    setResult(null);
    setError('');
  };
  const reload = () => {
    if (dirty) setDiscard('reload');
    else void load();
  };
  const save = async () => {
    if (!document || pending.current || !dirty || parsed.errors.length) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const saved = await writeHosts(content, document.revision);
      setDocument(saved.document);
      setContent(saved.document.content);
      setResult({ backup: saved.backupPath, dnsFlushed: saved.dnsFlushed });
    } catch (failure) {
      setError(errorText(t, failure, 'hosts.saveFailed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const retryDns = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await flushHostsDns();
      setResult((previous) => previous && { ...previous, dnsFlushed: true });
    } catch (failure) {
      setError(errorText(t, failure, 'err.hostsDns'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay">
      <div
        className="modal-window hosts-editor"
        role="dialog"
        aria-modal="true"
        aria-label={t('hosts.title')}
        ref={windowRef}
      >
        <div className="modal-head">
          <div>
            <h2 className="modal-title">
              <Network size={18} />
              {t('hosts.title')}
            </h2>
            {document && (
              <p className="hosts-path">
                {document.path} · {document.encoding}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={blocked}
            onClick={close}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
        {!isDesktopApp() && <p className="modal-hint">{t('hosts.demo')}</p>}
        <div className="hosts-toolbar">
          <div className="row-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!document || blocked}
              onClick={() => setSheet('new')}
            >
              <Plus size={15} />
              {t('hosts.add')}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!document || blocked}
              onClick={() => setSheet('batch')}
            >
              <ListPlus size={15} />
              {t('hosts.addMany')}
            </button>
          </div>
          <button type="button" className="secondary-button" onClick={reload} disabled={blocked}>
            <RefreshCw size={15} />
            {t('hosts.reload')}
          </button>
        </div>
        <div className="hosts-mode-row">
          <fieldset className="hosts-mode" aria-label={t('hosts.view')}>
            <button
              type="button"
              className={`secondary-button ${view === 'table' ? 'on' : ''}`}
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
              disabled={blocked}
            >
              <Table2 size={15} />
              {t('hosts.table')}
            </button>
            <button
              type="button"
              className={`secondary-button ${view === 'text' ? 'on' : ''}`}
              aria-pressed={view === 'text'}
              onClick={() => setView('text')}
              disabled={blocked}
            >
              <FileCode2 size={15} />
              {t('hosts.text')}
            </button>
          </fieldset>
          {document && (
            <span>
              {t('hosts.count', {
                count: parsed.entries.length,
                active: parsed.entries.filter((entry) => entry.active).length,
              })}
            </span>
          )}
        </div>
        <div className="hosts-editor-body" aria-busy={blocked}>
          {loading && <p className="empty-note">{t('common.loading')}</p>}
          {document && (
            <>
              <p className="hosts-info">
                {view === 'table' ? <LockKeyhole size={15} /> : <AlertTriangle size={15} />}
                {t(view === 'table' ? 'hosts.managedHint' : 'hosts.textHint')}
              </p>
              {view === 'text' ? (
                <div className="hosts-file-label">
                  <label htmlFor={inputId}>{t('hosts.fullFile')}</label>
                  <div className="hosts-file-editor">
                    <pre
                      ref={highlightRef}
                      className="hosts-file-highlight hljs"
                      aria-hidden="true"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightHosts escapes local text via highlight.js or escapeHtml.
                      dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }}
                    />
                    <textarea
                      id={inputId}
                      className="hosts-file-text"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      wrap="off"
                      value={content}
                      disabled={blocked}
                      onChange={(event) => change(event.target.value)}
                      onScroll={(event) => {
                        if (!highlightRef.current) return;
                        highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                        highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="hosts-table-wrap">
                  <table className="hosts-table">
                    <thead>
                      <tr>
                        <th>{t('hosts.enabled')}</th>
                        <th>{t('hosts.address')}</th>
                        <th>{t('hosts.names')}</th>
                        <th>{t('hosts.source')}</th>
                        <th>
                          <span className="sr-only">{t('projects.colActions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.entries.slice(0, limit).map((entry) => (
                        <tr key={entry.line}>
                          <td>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={entry.active}
                              aria-label={t('hosts.toggle', { host: entry.hosts })}
                              className={`hosts-toggle ${entry.active ? 'on' : ''}`}
                              disabled={entry.managed || blocked}
                              onClick={() => change(toggleHostsEntry(content, entry))}
                            >
                              <i />
                            </button>
                          </td>
                          <td className="hosts-ip">{entry.ip}</td>
                          <td>
                            <span className={entry.active ? '' : 'hosts-disabled'}>{entry.hosts}</span>
                            {entry.comment && <span className="hosts-entry-comment">{entry.comment}</span>}
                          </td>
                          <td>
                            <span className="hosts-source">
                              {entry.managed && <LockKeyhole size={12} />}
                              {t(entry.managed ? 'hosts.panelSource' : 'hosts.userSource')}
                            </span>
                          </td>
                          <td>
                            {!entry.managed && (
                              <button
                                type="button"
                                className="icon-button"
                                disabled={blocked}
                                onClick={() => setSheet(entry)}
                                aria-label={t('hosts.editEntry', { host: entry.hosts })}
                              >
                                <Pencil size={15} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!parsed.entries.length && <p className="empty-note">{t('hosts.empty')}</p>}
                  {parsed.entries.length > limit && (
                    <button type="button" className="secondary-button" onClick={() => setLimit(limit + 100)}>
                      {t('hosts.showMore')}
                    </button>
                  )}
                </div>
              )}
              {parsed.errors.length > 0 && <Issues issues={parsed.errors} />}
              {parsed.warnings.length > 0 && <Issues issues={parsed.warnings} />}
              {managedChanged && (
                <p className="hosts-info">
                  <AlertTriangle size={15} />
                  {t('hosts.managedChanged')}
                </p>
              )}
            </>
          )}
          {error && (
            <p className="hosts-error" role="alert">
              {error}
            </p>
          )}
          {result && (
            <div className="hosts-result" role="status">
              <p>
                <Check size={15} />
                {t(result.dnsFlushed ? 'hosts.applied' : 'hosts.savedDnsFailed')}
              </p>
              {result.backup && (
                <button
                  type="button"
                  className="hosts-backup-link"
                  onClick={() => void copyText(t, result.backup ?? '', 'hosts.backup', notify)}
                >
                  <Copy size={13} />
                  {t('hosts.backup')}: {result.backup}
                </button>
              )}
              {!result.dnsFlushed && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={blocked}
                  onClick={() => void retryDns()}
                >
                  {t('hosts.retryDns')}
                </button>
              )}
            </div>
          )}
        </div>
        <details className="hosts-apply-plan">
          <summary>{t('hosts.applyDetails')}</summary>
          <p>{t('hosts.applyHint')}</p>
          <p>
            <ShieldCheck size={13} />
            {t('hosts.adminHint')}
          </p>
        </details>
        {discard ? (
          <div className="modal-foot hosts-discard" role="alert">
            <span>{t('hosts.discardHint')}</span>
            <div className="row-actions">
              <button type="button" className="secondary-button" onClick={() => setDiscard(null)}>
                {t('hosts.keepEditing')}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setDiscard(null);
                  if (discard === 'close') onClose();
                  else void load();
                }}
              >
                {t(discard === 'close' ? 'hosts.discardClose' : 'hosts.discardReload')}
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-foot">
            <span className="modal-hint">{t(dirty ? 'hosts.unsaved' : 'hosts.clean')}</span>
            <div className="row-actions">
              <button type="button" className="secondary-button" disabled={blocked} onClick={close}>
                {t('common.close')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={blocked || !dirty || parsed.errors.length > 0}
                onClick={() => void save()}
              >
                {t(busy ? 'hosts.applying' : 'hosts.apply')}
              </button>
            </div>
          </div>
        )}
        {sheet && (
          <HostsEntrySheet
            content={content}
            entry={typeof sheet === 'object' ? sheet : null}
            batch={sheet === 'batch'}
            onClose={() => setSheet(null)}
            onChange={(next) => {
              change(next);
              setSheet(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function HostsEntrySheet({
  content,
  entry,
  batch,
  onClose,
  onChange,
}: {
  content: string;
  entry: HostsEntry | null;
  batch: boolean;
  onClose: () => void;
  onChange: (content: string) => void;
}) {
  const { t } = useI18n();
  const [ip, setIp] = useState(entry?.ip ?? '127.0.0.1');
  const [hosts, setHosts] = useState(entry?.hosts ?? '');
  const [comment, setComment] = useState(entry?.comment ?? '');
  const [active, setActive] = useState(entry?.active ?? true);
  const [block, setBlock] = useState('');
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useHostsDialog(ref, onClose);
  const preview = useMemo(() => parseHosts(block), [block]);
  const candidate = batch ? appendHostsBlock(content, block) : '';
  const batchErrors = batch ? parseHosts(candidate).errors : [];
  const markers = hostsBlockHasMarkers(block);
  const commit = () => {
    if (batch) {
      if (!preview.entries.length || batchErrors.length || markers) return;
      onChange(candidate);
      return;
    }
    if (!validHostsIp(ip.trim())) {
      setError(t('err.hostsIp', { line: 1 }));
      return;
    }
    const hostNames = hosts.trim();
    if (hostNames.length === 0 || !hostNames.split(/\s+/).every(validHostsName)) {
      setError(t('err.hostsName', { line: 1 }));
      return;
    }
    const value = { ip, hosts, comment, active };
    const next = entry
      ? changeHostsEntry(content, entry.line, value)
      : appendHostsBlock(
          content,
          `${active ? '' : '# '}${ip.trim()}\t${hosts.trim()}${comment.trim() ? `\t# ${comment.trim()}` : ''}`,
        );
    const validation = parseHosts(next);
    if (validation.errors.length) {
      setError(t(validation.errors[0].code, validation.errors[0].params));
      return;
    }
    onChange(next);
  };
  return (
    <div className="hosts-sheet-overlay">
      <div
        className="modal-window hosts-entry-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t(batch ? 'hosts.batchTitle' : entry ? 'hosts.edit' : 'hosts.new')}
        ref={ref}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <div className="modal-head">
            <h3 className="modal-title">
              {t(batch ? 'hosts.batchTitle' : entry ? 'hosts.edit' : 'hosts.new')}
            </h3>
            <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            {batch ? (
              <>
                <p className="modal-hint">{t('hosts.batchHint')}</p>
                <label className="module-select">
                  <span>{t('hosts.block')}</span>
                  <textarea
                    className="hosts-batch-text"
                    value={block}
                    onChange={(event) => setBlock(event.target.value)}
                    spellCheck={false}
                    placeholder={'127.0.0.1 shop.test www.shop.test\n127.0.0.1 api.shop.test'}
                  />
                </label>
                <p className="modal-hint" role="status">
                  {t('hosts.count', {
                    count: preview.entries.length,
                    active: preview.entries.filter((item) => item.active).length,
                  })}
                </p>
                <div className="hosts-batch-preview">
                  {preview.entries.slice(0, 5).map((item) => (
                    <div key={item.line}>
                      <span>{item.hosts}</span>
                      <span className="hosts-ip">{item.ip}</span>
                      <span>{t(item.active ? 'hosts.enabled' : 'hosts.disabled')}</span>
                    </div>
                  ))}
                </div>
                {batchErrors.length > 0 && <Issues issues={batchErrors} />}
                {markers && (
                  <p className="hosts-error" role="alert">
                    {t('hosts.noMarkers')}
                  </p>
                )}
              </>
            ) : (
              <>
                <label className="module-select">
                  <span>{t('hosts.address')}</span>
                  <input value={ip} onChange={(event) => setIp(event.target.value)} spellCheck={false} />
                </label>
                <label className="module-select">
                  <span>{t('hosts.names')}</span>
                  <input
                    value={hosts}
                    onChange={(event) => setHosts(event.target.value)}
                    spellCheck={false}
                  />
                  <span className="select-hint">{t('hosts.namesHint')}</span>
                </label>
                <label className="module-select">
                  <span>{t('hosts.comment')}</span>
                  <input value={comment} onChange={(event) => setComment(event.target.value)} />
                </label>
                <label className="hosts-checkbox">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={(event) => setActive(event.target.checked)}
                  />
                  {t('hosts.enabled')}
                </label>
              </>
            )}
            {error && (
              <p className="hosts-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-foot">
            {entry ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const lines = content.split('\n');
                  lines.splice(entry.line, 1);
                  onChange(lines.join('\n'));
                }}
              >
                <Trash2 size={14} />
                {t('hosts.delete')}
              </button>
            ) : (
              <span />
            )}
            <div className="row-actions">
              <button type="button" className="secondary-button" onClick={onClose}>
                {t('hosts.cancel')}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={batch && (!preview.entries.length || batchErrors.length > 0 || markers)}
              >
                {t(batch ? 'hosts.addEntries' : entry ? 'hosts.updateEntry' : 'hosts.add')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
