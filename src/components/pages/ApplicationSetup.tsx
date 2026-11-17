import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import {
  installProjectStarter,
  type LaravelInstalled,
  type LaravelInstallProgress,
  type OsPanelProject,
} from '../../ospanel';
import type { StarterInstall } from '../../projectTemplates';
import { starterText } from '../../projectTemplates';
import { Button, NoticeText, SectionPanel } from '../ui';
import { PathText } from '../widgets/PathText';
import './applicationSetup.css';

// The one-click setup card of a project: every text and command comes from the
// starter manifest, the card itself only knows the starter id and the status.
export function ApplicationSetup({
  project,
  starterId,
  status,
  install,
  disabled,
  dirty,
  onBusyChange,
  onInstalled,
}: {
  project: OsPanelProject;
  starterId: string;
  status: 'pending' | 'installed' | null | undefined;
  install?: StarterInstall;
  disabled: boolean;
  dirty: boolean;
  onBusyChange: (busy: boolean) => void;
  onInstalled: (result: LaravelInstalled) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<LaravelInstallProgress['phase']>('preparing');
  const [output, setOutput] = useState('');
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LaravelInstalled | null>(null);
  const pending = useRef(false);
  type InstallTextKey = 'title' | 'pending' | 'button' | 'hint' | 'unsaved' | 'done' | 'log' | 'backup';
  const text = (key: InstallTextKey) => starterText(install?.[key], lang);
  const phaseLabel = (key: string) => starterText(install?.phases[key] ?? '', lang);
  // Composer and installer output may contain ANSI terminal colours.
  const plainOutput = output.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes requires control characters
    /\u001b\[[0-?]*[ -/]*[@-~]/g,
    '',
  );
  if (status !== 'pending' && !running && !result) return null;
  const start = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setRunning(true);
    onBusyChange(true);
    setError('');
    setOutput('');
    setDownload(null);
    setPhase('preparing');
    try {
      const installed = await installProjectStarter(project, starterId, (progress) => {
        if (progress.downloaded != null && progress.total)
          setDownload({ received: progress.downloaded, total: progress.total });
        setPhase(progress.phase);
        if (progress.output) setOutput((current) => (current + progress.output).slice(-20000));
      });
      setResult(installed);
      await onInstalled(installed);
    } catch (error) {
      setError(errorText(t, error, 'err.installFailed'));
    } finally {
      pending.current = false;
      setRunning(false);
      onBusyChange(false);
    }
  };
  return (
    <SectionPanel className="workspace-card application-setup" aria-label={text('title')}>
      <div className="application-setup-head">
        <div>
          <h3>{text('title')}</h3>
          <p>{result ? text('done') : text('pending')}</p>
        </div>
        {!result && (
          <Button
            variant="primary"
            type="button"
            className="primary-button"
            disabled={disabled || running}
            onClick={() => void start()}
          >
            <Download size={15} />
            {text('button')}
          </Button>
        )}
      </div>
      {!result && (
        <p className="application-setup-hint">
          <PathText text={text('hint')} />
        </p>
      )}
      {!running && dirty && <p className="application-setup-hint">{text('unsaved')}</p>}
      {running && <p role="status">{phaseLabel(phase)}</p>}
      {running && download && (
        <progress
          className="application-download"
          value={download.received}
          max={download.total}
          aria-label={phaseLabel('downloading')}
        />
      )}
      {error && (
        <NoticeText className="workspace-error" role="alert">
          {error}
        </NoticeText>
      )}
      {result && (
        <p className="application-setup-hint">
          <PathText text={text('backup').replace('{path}', result.backupPath)} />
        </p>
      )}
      {output && (
        <details open={running || !!error}>
          <summary>{text('log')}</summary>
          <pre>{plainOutput}</pre>
        </details>
      )}
    </SectionPanel>
  );
}
