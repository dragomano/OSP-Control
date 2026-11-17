import { ArrowUpRight, Copy, FileCode2, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightConfig } from '../../highlight';
import { errorText, useI18n } from '../../i18n';
import {
  type ConfigFile,
  createBackup,
  listConfigs,
  openFileExternally,
  openProjectFolder,
  readConfigFile,
} from '../../ospanel';
import { copyText, formatSize, type Notify } from '../shared';
import { Button, EmptyState, Toolbar } from '../ui';
import { MenuSelect } from '../widgets/MenuSelect';
import { PageHeader } from '../widgets/PageHeader';
import { SearchField } from '../widgets/SearchField';

export function Configs({ notify }: { notify: Notify }) {
  const { t, plural } = useI18n();
  const [configs, setConfigs] = useState<ConfigFile[]>([]);
  const [selected, setSelected] = useState<ConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [service, setService] = useState('all');
  const openRequestRef = useRef(0);
  const openConfig = async (config: ConfigFile) => {
    const request = ++openRequestRef.current;
    setSelected(config);
    setContent('');
    setLoading(true);

    try {
      const nextContent = await readConfigFile(config.path);
      if (request === openRequestRef.current) setContent(nextContent);
    } catch (error) {
      if (request === openRequestRef.current) notify(errorText(t, error, 'configs.toastReadFailed'));
    } finally {
      if (request === openRequestRef.current) setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the config list is read once when the page opens — notify/t/openConfig are unstable and would cause a refetch loop
  useEffect(() => {
    void (async () => {
      try {
        const list = await listConfigs();
        setConfigs(list);
        if (list.length > 0) void openConfig(list[0]);
      } catch (error) {
        notify(errorText(t, error, 'configs.toastListFailed'));
      }
    })();
  }, []);

  const makeBackup = async () => {
    setBusy(true);
    try {
      const entry = await createBackup();
      notify(plural('configs.toastBackupDone', entry.files));
    } catch (error) {
      notify(errorText(t, error, 'configs.toastBackupFailed'));
    } finally {
      setBusy(false);
    }
  };
  const services = useMemo(() => Array.from(new Set(configs.map((item) => item.service))).sort(), [configs]);
  const visible = useMemo(
    () =>
      configs.filter(
        (item) =>
          (service === 'all' || item.service === service) &&
          item.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [configs, service, query],
  );
  const highlighted = useMemo(
    () => (selected ? highlightConfig(selected.name, content, selected.service) : ''),
    [selected, content],
  );

  return (
    <>
      <PageHeader
        eyebrow={t('nav.workspace')}
        heading={t('nav.configs')}
        description={t('configs.subtitle')}
        action={
          <Button
            variant="primary"
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void makeBackup()}
          >
            <Copy size={16} />
            {t('configs.backup')}
          </Button>
        }
      />
      <div className="configs-layout">
        <aside className="configs-list">
          <Toolbar className="configs-filters">
            <SearchField value={query} onChange={setQuery} placeholder={t('configs.searchPlaceholder')} />
            <MenuSelect
              value={service}
              ariaLabel={t('configs.allModules')}
              onChange={setService}
              options={[
                { value: 'all', label: t('configs.allModules') },
                ...services.map((item) => ({ value: item, label: item })),
              ]}
            />
          </Toolbar>
          <div className="configs-scroll">
            {visible.map((config) => (
              <Button
                layout="row"
                selected={Boolean(selected?.path === config.path)}
                variant="ghost"
                type="button"
                className={`config-item ${selected?.path === config.path ? 'selected' : ''}`}
                key={config.path}
                onClick={() => void openConfig(config)}
              >
                <FileCode2 size={15} />
                <div>
                  <b>{config.name}</b>
                  <span>
                    {config.service} · {formatSize(config.sizeBytes)}
                  </span>
                </div>
              </Button>
            ))}
            {visible.length === 0 && <EmptyState className="empty-note">{t('common.empty')}</EmptyState>}
          </div>
          <div className="configs-meta">
            {t('configs.shown', { visible: visible.length, total: configs.length })}
          </div>
        </aside>
        <section className="config-viewer editor-preview">
          {selected ? (
            <>
              <div className="editor-top">
                <div className="editor-file" title={`${selected.service} / ${selected.name}`}>
                  <span className="file-dot" />
                  {selected.service} / {selected.name}
                </div>
                <div className="editor-actions">
                  <Button
                    variant="ghost"
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void openFileExternally(selected.path).catch((error) =>
                        notify(errorText(t, error, 'configs.toastFileFailed')),
                      )
                    }
                  >
                    <ArrowUpRight size={13} />
                    {t('configs.open')}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void openProjectFolder(selected.path).catch((error) =>
                        notify(errorText(t, error, 'configs.toastFolderFailed')),
                      )
                    }
                  >
                    <FolderOpen size={13} />
                    {t('configs.folder')}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    className="text-button"
                    onClick={() => void copyText(t, content, 'label.file', notify)}
                  >
                    <Copy size={13} />
                    {t('configs.copy')}
                  </Button>
                </div>
              </div>
              <pre>
                <code
                  className="hljs"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: content is escaped in highlightConfig (escapeHtml / hljs.highlight); only local text is inserted
                  dangerouslySetInnerHTML={{ __html: loading ? t('common.loading') : highlighted }}
                />
              </pre>
            </>
          ) : (
            <div className="viewer-hint">{t('configs.viewerHint')}</div>
          )}
        </section>
      </div>
    </>
  );
}
