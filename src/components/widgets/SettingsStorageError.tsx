import { useEffect, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import { flushSettings, settingsFailure, subscribeSettingsFailure } from '../../settingsStorage';

export function SettingsStorageError() {
  const { t } = useI18n();
  const [error, setError] = useState(settingsFailure);
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeSettingsFailure(() => setError(settingsFailure())), []);
  if (!error) return null;
  return (
    <div className="settings-storage-error" role="alert">
      <span>{errorText(t, error, 'settings.storageFailed')}</span>
      <button
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
      </button>
    </div>
  );
}
