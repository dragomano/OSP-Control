import { describe, expect, it } from 'vitest';
import { buildActivityRows, logAliasesFromTranslator } from '../src/components/tables/Logs';
import { embeddedDict, makeTranslator } from '../src/i18n';

const ruAliases = logAliasesFromTranslator(makeTranslator(embeddedDict('ru'), embeddedDict('en')));

const FRAME = '+—————————————————————————————————————————————————————————————————————————————';

// Blocks from the panel's real logs/general.log (the fixtures use the panel's Russian output):
// inside the warning block there is the service field "Exit/error code: 1", which used to make
// the text search classify the warning as an error, leaving the "Warnings" tab empty.
const WARNING_BLOCK = [
  `[2026-10-07 00:05:20] ${FRAME}`,
  '[2026-10-07 00:05:20] | ПРЕДУПРЕЖДЕНИЕ',
  `[2026-10-07 00:05:20] |${FRAME.slice(1)}`,
  '[2026-10-07 00:05:20] | Модуль: Nginx (default)',
  '[2026-10-07 00:05:20] | Объект: PID 127648',
  '[2026-10-07 00:05:20] | Код выхода/ошибки: 1',
  '[2026-10-07 00:05:20] | Сообщение: Автоматический перезапуск рабочего процесса модуля...',
  '[2026-10-07 00:05:20] | Причина: Рабочий процесс модуля неожиданно завершил свою работу',
  `[2026-10-07 00:05:20] ${FRAME}`,
];

const ERROR_BLOCK = [
  `[2026-10-07 08:03:55] ${FRAME}`,
  '[2026-10-07 08:03:55] | ОШИБКА',
  `[2026-10-07 08:03:55] |${FRAME.slice(1)}`,
  '[2026-10-07 08:03:55] | Сообщение: Не удалось подключиться к серверу проверки обновлений',
  '[2026-10-07 08:03:55] | Причина: Socket Error # 11001 Host not found.',
  `[2026-10-07 08:03:55] ${FRAME}`,
];

describe('buildActivityRows', () => {
  it('keeps a block with the warning marker on the warning level', () => {
    const rows = buildActivityRows(WARNING_BLOCK, ruAliases);

    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('warning');
    expect(rows[0].time).toBe('2026-10-07 00:05:20');
  });

  it('keeps a block with the error marker on the error level', () => {
    const rows = buildActivityRows(ERROR_BLOCK, ruAliases);

    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('error');
  });

  it('counts warnings and errors separately across a mixed tail', () => {
    const rows = buildActivityRows(
      [
        '[2026-10-07 00:06:24] Nginx (default): Рабочий процесс модуля запущен',
        ...WARNING_BLOCK,
        ...ERROR_BLOCK,
      ],
      ruAliases,
    );

    expect(rows.filter((row) => row.level === 'warning')).toHaveLength(1);
    expect(rows.filter((row) => row.level === 'error')).toHaveLength(1);
    expect(rows.filter((row) => row.level === 'info')).toHaveLength(1);
  });

  it('joins the message and reason of a block into one entry, module first', () => {
    const [row] = buildActivityRows(WARNING_BLOCK, ruAliases);

    expect(row.text).toBe(
      'Nginx (default) — Автоматический перезапуск рабочего процесса модуля... — Рабочий процесс модуля неожиданно завершил свою работу',
    );
  });

  it('leaves a block without a module line unchanged', () => {
    const [row] = buildActivityRows(ERROR_BLOCK, ruAliases);

    expect(row.text).toBe(
      'Не удалось подключиться к серверу проверки обновлений — Socket Error # 11001 Host not found.',
    );
  });

  it('does not repeat the module when the block has no message line', () => {
    const rows = buildActivityRows(
      [
        '[2026-10-07 00:05:20] | ПРЕДУПРЕЖДЕНИЕ',
        '[2026-10-07 00:05:20] | Модуль: Nginx (default)',
        `[2026-10-07 00:05:20] ${FRAME}`,
      ],
      ruAliases,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('warning');
    expect(rows[0].text).toBe('Nginx (default) — ПРЕДУПРЕЖДЕНИЕ');
  });

  it('falls back to the line text when a block carries no level marker', () => {
    const rows = buildActivityRows(
      ['[2026-10-07 08:03:55] | Модуль: Nginx (default)', '[2026-10-07 08:04:01] | Код выхода/ошибки: 1'],
      ruAliases,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('error');
  });

  it('recognizes structured levels regardless of message language', () => {
    const rows = buildActivityRows([
      '[2026-10-07 08:04:01] {"level":"error","msg":"failed"}',
      '[2026-10-07 08:04:02] severity=warning mensaje',
      '[2026-10-07 08:04:03] [INFO] servicio iniciado',
    ]);

    expect(rows.map((row) => row.level)).toEqual(['error', 'warning', 'info']);
  });

  it('uses aliases from any locale without changing the classifier', () => {
    const aliases = logAliasesFromTranslator(
      (key) =>
        ({
          'logs.level.errorAliases': 'kaputt',
          'logs.level.warningAliases': 'vorsicht',
          'logs.level.infoAliases': 'hinweis',
        })[key] ?? key,
    );
    const rows = buildActivityRows(
      [
        '[2026-10-07 08:04:01] kaputt: module failed',
        '[2026-10-07 08:04:02] vorsicht: old config',
        '[2026-10-07 08:04:03] hinweis: ready',
      ],
      aliases,
    );

    expect(rows.map((row) => row.level)).toEqual(['error', 'warning', 'info']);
  });

  it('does not promote a warning block because of an incidental error field', () => {
    const rows = buildActivityRows(
      [
        '[2026-10-07 08:04:01] | ПРЕДУПРЕЖДЕНИЕ',
        '[2026-10-07 08:04:01] | Код ошибки: 1',
        '[2026-10-07 08:04:01] | Сообщение: Перезапуск',
        `[2026-10-07 08:04:01] ${FRAME}`,
      ],
      ruAliases,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe('warning');
  });
});
