import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  installProjectLaravel,
  installProjectWordPress,
  type LaravelInstalled,
  type LaravelInstallProgress,
  type OsPanelProject,
} from '../../ospanel';
import { PathText } from '../widgets/PathText';
import './applicationSetup.css';

export function ApplicationSetup({
  project,
  kind = 'laravel',
  state,
  disabled,
  dirty,
  onBusyChange,
  onInstalled,
}: {
  project: OsPanelProject;
  kind?: 'laravel' | 'wordpress';
  state: 'pending' | 'installed' | null | undefined;
  disabled: boolean;
  dirty: boolean;
  onBusyChange: (busy: boolean) => void;
  onInstalled: (result: LaravelInstalled) => Promise<void>;
}) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<LaravelInstallProgress['phase']>('preparing');
  const [output, setOutput] = useState('');
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LaravelInstalled | null>(null);
  const pending = useRef(false);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Composer and Artisan may emit ANSI terminal colours.
  const plainOutput = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (state !== 'pending' && !running && !result) return null;
  const install = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setRunning(true);
    onBusyChange(true);
    setError('');
    setOutput('');
    setDownload(null);
    setPhase('preparing');
    try {
      const installed = await (kind === 'wordpress' ? installProjectWordPress : installProjectLaravel)(
        project,
        (progress) => {
          if (progress.downloaded != null && progress.total)
            setDownload({ received: progress.downloaded, total: progress.total });
          setPhase(progress.phase);
          if (progress.output) setOutput((current) => (current + progress.output).slice(-20000));
        },
      );
      setResult(installed);
      await onInstalled(installed);
    } catch (error) {
      setError(errorText(t, error, `err.${kind}Install`));
    } finally {
      pending.current = false;
      setRunning(false);
      onBusyChange(false);
    }
  };
  return (
    <section className="workspace-card application-setup" aria-label={t(`${kind}.title`)}>
      <div className="application-setup-head">
        <div>
          <h3>{t(`${kind}.title`)}</h3>
          <p>{t(result ? `${kind}.done` : `${kind}.pending`)}</p>
        </div>
        {!result && (
          <button
            type="button"
            className="primary-button"
            disabled={disabled || running}
            onClick={() => void install()}
          >
            <Download size={15} />
            {t(`${kind}.install`)}
          </button>
        )}
      </div>
      {!result && (
        <p className="application-setup-hint">
          <PathText text={t(`${kind}.hint`)} />
        </p>
      )}
      {!running && dirty && <p className="application-setup-hint">{t(`${kind}.unsaved`)}</p>}
      {running && <p role="status">{t(`${kind}.${phase}`)}</p>}
      {running && download && (
        <progress
          className="application-download"
          value={download.received}
          max={download.total}
          aria-label={t(`${kind}.downloading`)}
        />
      )}
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="application-setup-hint">
          <PathText text={t(`${kind}.backup`, { path: result.backupPath })} />
        </p>
      )}
      {output && (
        <details open={running || !!error}>
          <summary>{t(`${kind}.log`)}</summary>
          <pre>{plainOutput}</pre>
        </details>
      )}
    </section>
  );
}
