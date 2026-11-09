import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ProjectTask,
  parseProjectTasks,
  renderProjectTasks,
  taskErrors,
  taskPreset,
  uniqueTaskName,
  validTaskCronField,
} from '../src/projectTasks';

const source =
  '\uFEFF; Project automation\r\n[shop.test] ; keep section comment\r\n\r\nBuild assets    = */5 * * * 1-5 * * cmd.exe /c "osp project {host} & echo x=y; #literal %PATH%"\r\n; keep this comment\r\nStart app = * * * * * 1 0 cmd.exe /c "osp project {host} start"\r\n\r\n[api.shop.test]\r\nCheck = 5 4 * * 7 0 1 echo {base_dir}\r\n';
const newTask = (patch: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 'new',
  domain: 'shop.test',
  name: 'New action',
  schedule: ['0', '0', '*', '*', '*'],
  limit: '*',
  enabled: '0',
  command: 'echo {host}',
  ...patch,
});

describe('project task definitions', () => {
  it('round-trips BOM, comments, CRLF, inactive tasks and opaque shell commands byte for byte', () => {
    const doc = parseProjectTasks(source);
    expect(doc.errors).toEqual([]);
    expect(doc.tasks).toHaveLength(3);
    expect(doc.tasks[0].command).toContain('echo x=y; #literal %PATH%');
    expect(doc.tasks[1]).toMatchObject({ limit: '1', enabled: '0' });
    expect(doc.tasks[2]).toMatchObject({
      domain: 'api.shop.test',
      schedule: ['5', '4', '*', '*', '7'],
      limit: '0',
      enabled: '1',
    });
    expect(renderProjectTasks(source, doc.tasks)).toBe(source);
  });
  it('changes one row, preserves the other domain and retains surrounding formatting on rename', () => {
    const tasks = parseProjectTasks(source).tasks;
    tasks[0] = { ...tasks[0], name: 'Compile assets' };
    expect(renderProjectTasks(source, tasks)).toBe(source.replace('Build assets', 'Compile assets'));
    tasks[1] = { ...tasks[1], enabled: '1', command: 'cmd.exe /c "echo {host} & echo a=b"' };
    const rendered = renderProjectTasks(source, tasks);
    expect(parseProjectTasks(rendered).tasks[1]).toMatchObject(tasks[1]);
    expect(rendered.slice(rendered.indexOf('[api.shop.test]'))).toBe(
      source.slice(source.indexOf('[api.shop.test]')),
    );
  });
  it('adds to existing and new domain sections and deletes rows without dropping comments', () => {
    const tasks = parseProjectTasks(source).tasks;
    const additions = [
      newTask(),
      newTask({ id: 'second', domain: 'api.shop.test' }),
      newTask({ id: 'third', domain: 'worker.shop.test' }),
    ];
    const rendered = renderProjectTasks(source, [
      ...tasks.filter((task) => task.name !== 'Start app'),
      ...additions,
    ]);
    const doc = parseProjectTasks(rendered);
    expect(doc.errors).toEqual([]);
    expect(doc.tasks).toHaveLength(5);
    for (const added of additions)
      expect(doc.tasks).toContainEqual(
        expect.objectContaining({ domain: added.domain, name: added.name, command: added.command }),
      );
    expect(rendered).toContain('; keep this comment\r\n');
    expect(rendered).not.toContain('Start app =');
    expect(renderProjectTasks('', [newTask()])).toBe('[shop.test]\nNew action = 0 0 * * * * 0 echo {host}\n');
    expect(parseProjectTasks(renderProjectTasks('[shop.test]', [newTask()])).tasks).toHaveLength(1);
  });
  it('rejects ambiguous files and invalid changes instead of losing unrecognized content', () => {
    for (const input of [
      'task = * * * * * * 1 echo\n',
      '[shop.test]\nunsupported\n',
      '[shop.test]\n[SHOP.TEST]\n',
    ]) {
      expect(parseProjectTasks(input).errors.length).toBeGreaterThan(0);
      expect(() => renderProjectTasks(input, [])).toThrow('err.projectWorkspaceInvalid');
    }
    for (const patch of [
      { name: 'bad=key' },
      { name: '; comment' },
      { name: 'new\n[injected]' },
      { command: 'echo\n[bad]' },
      { limit: '-1' },
      { enabled: '2' },
      { domain: 'bad/domain' },
    ])
      expect(() => renderProjectTasks('', [newTask(patch)])).toThrow('err.projectWorkspaceInvalid');
    expect(() => renderProjectTasks('', [newTask(), newTask({ id: 'other' })])).toThrow();
    expect(taskErrors(newTask({ command: '' }), [])).toContain('command');
  });
  it('validates OSPanel numeric cron syntax and Monday to Sunday numbering', () => {
    for (const value of ['*', '0', '59', '1,3,5', '0-59/2', '*/5', '1-10/3,20-30/2'])
      expect(validTaskCronField(value, 0)).toBe(true);
    for (const value of ['', '60', '-1', '*/0', '*/-2', '9-2', '1,,2', '@hourly', 'MON', '1/0'])
      expect(validTaskCronField(value, 0)).toBe(false);
    expect(validTaskCronField('0', 4)).toBe(false);
    expect(validTaskCronField('1-7', 4)).toBe(true);
    expect(validTaskCronField('8', 4)).toBe(false);
    expect(taskPreset(newTask())).toBe('daily');
    expect(taskPreset(newTask({ schedule: ['15', '4', '*', '*', '*'] }))).toBe('custom');
    expect(uniqueTaskName([newTask()], 'shop.test', 'New action')).toBe('New action (2)');
    expect(uniqueTaskName([newTask()], 'api.shop.test', 'New action')).toBe('New action');
  });
  it.skipIf(!process.env.OSP_CONTROL_PROJECT_TASK_SAMPLE)(
    'reads the installed sample without writing to it',
    () => {
      const raw = readFileSync(process.env.OSP_CONTROL_PROJECT_TASK_SAMPLE as string, 'utf8');
      const doc = parseProjectTasks(raw);
      expect(doc.tasks.length).toBeGreaterThan(0);
      expect(doc.errors).toEqual([]);
      expect(renderProjectTasks(raw, doc.tasks)).toBe(raw);
    },
  );
});
