import { useEffect, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import { flushSettings, settingsFailure, subscribeSettingsFailure } from '../../settingsStorage';
import { Button, Notice } from '../ui';

export function SettingsStorageError() {
  const { t } = useI18n();
  const [error, setError] = useState(settingsFailure);
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeSettingsFailure(() => setError(settingsFailure())), []);
  if (!error) return null;
  return (
    <Notice className="settings-storage-error" role="alert">
      <span>{errorText(t, error, 'settings.storageFailed')}</span>
      <Button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await flushSettings();
          setBusy(false);
        }}
      >
        {t('settings.storageRetry')}
      </Button>
    </Notice>
  );
}
