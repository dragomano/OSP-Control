import { normalizeProjectDomain } from './projectDomain';

export type ProjectTask = {
  id: string;
  domain: string;
  name: string;
  schedule: string[];
  limit: string;
  enabled: string;
  command: string;
};
export type ProjectTasksDocument = {
  tasks: ProjectTask[];
  errors: number[];
};
export const TASK_CRON_FIELDS = ['minute', 'hour', 'day', 'month', 'weekday'] as const;
const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [1, 7],
] as const;
export const TASK_SCHEDULE_PRESETS = {
  minute: ['*', '*', '*', '*', '*'],
  fiveMinutes: ['*/5', '*', '*', '*', '*'],
  hourly: ['0', '*', '*', '*', '*'],
  daily: ['0', '0', '*', '*', '*'],
  weekdays: ['0', '9', '*', '*', '1-5'],
  weekly: ['0', '0', '*', '*', '1'],
  monthly: ['0', '0', '1', '*', '*'],
} as const;
export type TaskPreset = keyof typeof TASK_SCHEDULE_PRESETS;

const linesOf = (source: string) => source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const lineText = (line: string) => line.replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
const sectionOf = (line: string) => lineText(line).match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/)?.[1];
const domainOf = (value: string) => normalizeProjectDomain(value) ?? value.toLowerCase();

// Commands are opaque text: shell operators, quotes and template variables are never interpreted.
export function parseProjectTasks(source: string): ProjectTasksDocument {
  const tasks: ProjectTask[] = [];
  const errors: number[] = [];
  const sections = new Set<string>();
  let domain = '';
  for (const [index, line] of linesOf(source).entries()) {
    const text = lineText(line);
    if (!text.trim() || /^\s*[;#]/.test(text)) continue;
    const section = sectionOf(line);
    if (section !== undefined) {
      domain = domainOf(section.trim());
      if (!normalizeProjectDomain(domain) || sections.has(domain)) errors.push(index + 1);
      sections.add(domain);
      continue;
    }
    const property = text.match(/^\s*([^=]+?)\s*=\s*(.*)$/);
    const value = property?.[2].match(
      /^(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)(?:[ \t]+(.*))?$/,
    );
    if (!domain || !property || !value) {
      errors.push(index + 1);
      continue;
    }
    tasks.push({
      id: `line_${index}`,
      domain,
      name: property[1].trim(),
      schedule: value.slice(1, 6),
      limit: value[6],
      enabled: value[7],
      command: value[8] ?? '',
    });
  }
  return { tasks, errors };
}

export function validTaskCronField(value: string, index: number): boolean {
  const bounds = RANGES[index];
  if (!bounds) return false;
  const [min, max] = bounds;
  return value.split(',').every((part) => {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) return false;
    if (match[2] && (+match[2] < 1 || !Number.isSafeInteger(+match[2]))) return false;
    if (match[1] === '*') return true;
    const [start, end = start] = match[1].split('-').map(Number);
    return start >= min && end <= max && start <= end;
  });
}

export function taskErrors(task: ProjectTask, tasks: ProjectTask[]): string[] {
  const errors: string[] = [];
  if (task.schedule.length !== 5) errors.push('minute');
  if (
    !task.name.trim() ||
    task.name !== task.name.trim() ||
    /[=[\]\r\n\0]/.test(task.name) ||
    /^[;#]/.test(task.name)
  )
    errors.push('name');
  else if (
    tasks.some(
      (other) =>
        other.id !== task.id &&
        other.domain === task.domain &&
        other.name.toLowerCase() === task.name.toLowerCase(),
    )
  )
    errors.push('duplicateName');
  for (let index = 0; index < 5; index++)
    if (!validTaskCronField(task.schedule[index] ?? '', index)) errors.push(TASK_CRON_FIELDS[index]);
  if (task.limit !== '*' && (!/^\d+$/.test(task.limit) || !Number.isSafeInteger(+task.limit)))
    errors.push('limit');
  if (!['*', '0', '1'].includes(task.enabled)) errors.push('enabled');
  if (!task.command.trim() || /[\r\n\0]/.test(task.command)) errors.push('command');
  if (!normalizeProjectDomain(task.domain)) errors.push('domain');
  return errors;
}

export function taskPreset(task: ProjectTask): TaskPreset | 'custom' {
  return (
    (Object.keys(TASK_SCHEDULE_PRESETS) as TaskPreset[]).find((key) =>
      TASK_SCHEDULE_PRESETS[key].every((value, index) => value === task.schedule[index]),
    ) ?? 'custom'
  );
}

export function uniqueTaskName(tasks: ProjectTask[], domain: string, name: string): string {
  const used = new Set(tasks.filter((task) => task.domain === domain).map((task) => task.name.toLowerCase()));
  let candidate = name;
  let index = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${name} (${index++})`;
  return candidate;
}

// Replace only task rows; retain comments, section spelling, alignment, BOM and original line endings.
export function renderProjectTasks(source: string, tasks: ProjectTask[]): string {
  const original = parseProjectTasks(source);
  if (original.errors.length || tasks.some((task) => taskErrors(task, tasks).length))
    throw new Error('err.projectWorkspaceInvalid');
  const lines = linesOf(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const originalIds = new Set(original.tasks.map((task) => task.id));
  const current = new Map(tasks.map((task) => [task.id, task]));
  if (current.size !== tasks.length) throw new Error('err.projectWorkspaceInvalid');
  const output = [...lines];
  const payload = (task: ProjectTask) =>
    `${task.schedule.join(' ')} ${task.limit} ${task.enabled} ${task.command}`;
  for (const previous of original.tasks) {
    const index = Number(previous.id.slice(5));
    const next = current.get(previous.id);
    if (!next) {
      output[index] = lines[index].startsWith('\uFEFF') ? '\uFEFF' : '';
      continue;
    }
    if (next.domain !== previous.domain) throw new Error('err.projectWorkspaceInvalid');
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    const parts = lineText(lines[index]).match(/^(\s*)([^=]*?)(\s*=[ \t]*)(.*)$/);
    if (!parts) throw new Error('err.projectWorkspaceInvalid');
    const ending = lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : '';
    const value = payload(next) === payload(previous) ? parts[4] : payload(next);
    output[index] =
      `${lines[index].startsWith('\uFEFF') ? '\uFEFF' : ''}${parts[1]}${next.name}${parts[3]}${value}${ending}`;
  }
  const added = tasks.filter((task) => !originalIds.has(task.id));
  const append = (index: number, rows: string[]) => {
    if (index > 0 && output[index - 1] && !output[index - 1].endsWith('\n')) output[index - 1] += newline;
    output.splice(index, 0, ...rows);
  };
  // Work backwards so inserting into one section cannot shift another section's original indices.
  const sections = lines
    .map((line, index) => ({ domain: sectionOf(line), index }))
    .filter((section) => section.domain !== undefined);
  const remaining = new Set(added.map((task) => task.domain));
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    const domain = domainOf(section.domain?.trim() ?? '');
    const entries = added.filter((task) => task.domain === domain);
    if (!entries.length) continue;
    append(
      sections[i + 1]?.index ?? lines.length,
      entries.map((task) => `${task.name} = ${payload(task)}${newline}`),
    );
    remaining.delete(domain);
  }
  for (const domain of remaining) {
    append(output.length, [
      `[${domain}]${newline}`,
      ...added
        .filter((task) => task.domain === domain)
        .map((task) => `${task.name} = ${payload(task)}${newline}`),
    ]);
  }
  return output.join('');
}
