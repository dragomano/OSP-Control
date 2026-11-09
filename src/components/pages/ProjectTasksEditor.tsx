import { Check, Clock3, Copy, Plus, Search, Terminal, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useI18n } from '../../i18n';
import { askConfirm } from '../../ospanel';
import {
  type ProjectTask,
  type ProjectTasksDocument,
  TASK_CRON_FIELDS,
  TASK_SCHEDULE_PRESETS,
  type TaskPreset,
  taskErrors,
  taskPreset,
  uniqueTaskName,
} from '../../projectTasks';
import '../widgets/formControls.css';
import './projectTasksEditor.css';

export function ProjectTasksEditor({
  document,
  tasks,
  domain,
  disabled,
  onChange,
}: {
  document: ProjectTasksDocument;
  tasks: ProjectTask[];
  domain: string;
  disabled: boolean;
  onChange: (tasks: ProjectTask[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [selected, setSelected] = useState<Pick<ProjectTask, 'id' | 'domain' | 'name'> | null>(null);
  const [query, setQuery] = useState('');
  const entries = tasks.filter((task) => task.domain === domain);
  const visible = entries.filter((task) =>
    `${task.name} ${task.command}`.toLowerCase().includes(query.toLowerCase()),
  );
  const task =
    entries.find((task) => task.id === selected?.id) ??
    entries.find((task) => task.domain === selected?.domain && task.name === selected?.name) ??
    entries[0];
  const errors = task ? taskErrors(task, tasks) : [];
  const update = (patch: Partial<ProjectTask>) => {
    if (task) {
      setSelected({ id: task.id, domain: task.domain, name: patch.name ?? task.name });
      onChange(tasks.map((item) => (item.id === task.id ? { ...item, ...patch } : item)));
    }
  };
  const add = (copy?: ProjectTask) => {
    const next: ProjectTask = {
      id: crypto.randomUUID(),
      domain,
      name: uniqueTaskName(
        tasks,
        domain,
        copy ? t('tasks.copyName', { name: copy.name }) : t('tasks.newName'),
      ),
      schedule: copy ? [...copy.schedule] : ['*', '*', '*', '*', '*'],
      limit: copy?.limit ?? '*',
      enabled: '0',
      command: copy?.command ?? '',
    };
    onChange([...tasks, next]);
    setSelected(next);
    setQuery('');
  };
  const errorId = (key: string) => (errors.includes(key) ? `${id}-${key}` : undefined);
  const error = (key: string) =>
    errors.includes(key) && (
      <small className="tasks-field-error" id={errorId(key)}>
        {t(`tasks.error.${key}`)}
      </small>
    );

  return (
    <fieldset className="tasks-editor" disabled={disabled || document.errors.length > 0}>
      {document.errors.length > 0 && (
        <div className="workspace-error" role="alert">
          {t('tasks.parseError', { lines: document.errors.join(', ') })}
        </div>
      )}
      <div className="tasks-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={t('tasks.search')}
            placeholder={t('tasks.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" className="secondary-button" onClick={() => add()}>
          <Plus size={15} />
          {t('tasks.add')}
        </button>
      </div>
      <div className="tasks-editor-layout">
        <section className="workspace-card tasks-list-panel" aria-label={t('tasks.list')}>
          <div className="tasks-panel-head">
            <strong>
              <Clock3 size={16} />
              {t('tasks.list')}
            </strong>
            <span>{t('tasks.count', { n: entries.length })}</span>
          </div>
          <div className="tasks-list">
            {visible.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`tasks-list-item${item.id === task?.id ? ' selected' : ''}`}
                aria-pressed={item.id === task?.id}
                onClick={() => setSelected(item)}
              >
                <span
                  className={`tasks-state${item.enabled === '0' ? '' : ' enabled'}`}
                  title={t(item.enabled === '0' ? 'workspace.off' : 'workspace.on')}
                >
                  <Check size={13} />
                </span>
                <span>
                  <b>{item.name || t('tasks.newName')}</b>
                  <code>{item.schedule.join(' ')}</code>
                  <small>{t(item.enabled === '0' ? 'workspace.off' : 'workspace.on')}</small>
                </span>
                {taskErrors(item, tasks).length > 0 && (
                  <TriangleAlert className="tasks-invalid-mark" size={15} aria-label={t('tasks.fixErrors')} />
                )}
              </button>
            ))}
            {!visible.length && (
              <div className="empty-note">{t(entries.length ? 'common.empty' : 'tasks.empty')}</div>
            )}
          </div>
        </section>
        <section className="workspace-card tasks-inspector" aria-label={t('tasks.properties')}>
          {task ? (
            <>
              <div className="tasks-inspector-head">
                <span className="tasks-task-icon">
                  <Terminal size={24} />
                </span>
                <div>
                  <span>{t('tasks.properties')}</span>
                  <strong>{task.name || t('tasks.newName')}</strong>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('tasks.duplicate')}
                  title={t('tasks.duplicate')}
                  onClick={() => add(task)}
                >
                  <Copy size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={t('tasks.delete')}
                  title={t('tasks.delete')}
                  onClick={() =>
                    void (async () => {
                      if (
                        await askConfirm(
                          t('tasks.deleteConfirm', { name: task.name }),
                          t('common.confirmTitle'),
                        )
                      )
                        onChange(tasks.filter((item) => item.id !== task.id));
                    })()
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <label className="tasks-field">
                <span>{t('tasks.name')}</span>
                <input
                  aria-label={t('tasks.name')}
                  aria-describedby={errorId('name') ?? errorId('duplicateName')}
                  value={task.name}
                  aria-invalid={errors.includes('name') || errors.includes('duplicateName')}
                  onChange={(event) => update({ name: event.target.value })}
                />
                {error('name')}
                {error('duplicateName')}
              </label>
              <label className="tasks-enabled">
                <input
                  type="checkbox"
                  checked={task.enabled !== '0'}
                  onChange={(event) => update({ enabled: event.target.checked ? '1' : '0' })}
                />
                {t('tasks.enabled')}
              </label>
              {error('enabled')}
              <label className="tasks-field">
                <span>{t('tasks.schedule')}</span>
                <select
                  value={taskPreset(task)}
                  onChange={(event) => {
                    if (event.target.value !== 'custom')
                      update({ schedule: [...TASK_SCHEDULE_PRESETS[event.target.value as TaskPreset]] });
                  }}
                >
                  <option value="custom">{t('tasks.preset.custom')}</option>
                  {(Object.keys(TASK_SCHEDULE_PRESETS) as TaskPreset[]).map((key) => (
                    <option key={key} value={key}>
                      {t(`tasks.preset.${key}`)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="tasks-cron-fields">
                {TASK_CRON_FIELDS.map((key, index) => (
                  <label className="tasks-field" key={key}>
                    <span>{t(`tasks.${key}`)}</span>
                    <input
                      aria-label={t(`tasks.${key}`)}
                      aria-describedby={errorId(key)}
                      value={task.schedule[index] ?? ''}
                      aria-invalid={errors.includes(key)}
                      spellCheck={false}
                      onChange={(event) =>
                        update({
                          schedule: task.schedule.map((value, i) =>
                            i === index ? event.target.value : value,
                          ),
                        })
                      }
                    />
                    {error(key)}
                  </label>
                ))}
              </div>
              <p className="tasks-help">{t('tasks.cronHint')}</p>
              <div className="tasks-limit-fields">
                <label className="tasks-field">
                  <span>{t('tasks.limit')}</span>
                  <select
                    value={['*', '0'].includes(task.limit) ? 'unlimited' : 'limited'}
                    onChange={(event) => update({ limit: event.target.value === 'unlimited' ? '*' : '1' })}
                  >
                    <option value="unlimited">{t('tasks.unlimited')}</option>
                    <option value="limited">{t('tasks.limited')}</option>
                  </select>
                </label>
                {!['*', '0'].includes(task.limit) && (
                  <label className="tasks-field">
                    <span>{t('tasks.launchCount')}</span>
                    <input
                      aria-label={t('tasks.launchCount')}
                      aria-describedby={errorId('limit')}
                      type="number"
                      min={1}
                      step={1}
                      value={task.limit}
                      aria-invalid={errors.includes('limit')}
                      onChange={(event) => update({ limit: event.target.value })}
                    />
                    {error('limit')}
                  </label>
                )}
              </div>
              <label className="tasks-field">
                <span>{t('tasks.command')}</span>
                <textarea
                  aria-label={t('tasks.command')}
                  aria-describedby={errorId('command')}
                  rows={3}
                  value={task.command}
                  aria-invalid={errors.includes('command')}
                  spellCheck={false}
                  onChange={(event) => update({ command: event.target.value })}
                />
                {error('command')}
              </label>
              <p className="tasks-help">{t('tasks.commandHint')}</p>
            </>
          ) : (
            <div className="tasks-empty-inspector">
              <Clock3 size={32} />
              <p>{t('tasks.select')}</p>
            </div>
          )}
        </section>
      </div>
      <p className="workspace-hint">{t('tasks.applyHint')}</p>
    </fieldset>
  );
}
