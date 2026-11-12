import { describe, expect, it } from 'vitest';
import { mergeProjectEditors } from '../src/projectEditors';

describe('project editor merging', () => {
  it('replaces a detected editor by executable stem and keeps unrelated editors', () => {
    expect(
      mergeProjectEditors(
        [
          { id: 'vscode', name: 'VS Code', exe: 'code' },
          { id: 'zed', name: 'Zed', exe: 'zed' },
        ],
        [
          { id: 'first', name: 'Microsoft VS Code', exe: 'code' },
          { id: 'last', name: 'Zed', exe: 'zed' },
          { id: 'empty', name: ' ', exe: '' },
        ],
      ),
    ).toEqual([
      { id: 'first', name: 'VS Code', exe: 'code', custom: true },
      { id: 'last', name: 'Zed', exe: 'zed', custom: true },
    ]);
  });

  it('keeps the path-derived name for a custom program without a detected editor', () => {
    expect(
      mergeProjectEditors(
        [{ id: 'vscode', name: 'VS Code', exe: 'code' }],
        [{ id: 'sublime', name: 'Sublime Text', exe: 'subl' }],
      ),
    ).toEqual([
      { id: 'vscode', name: 'VS Code', exe: 'code' },
      { id: 'sublime', name: 'Sublime Text', exe: 'subl', custom: true },
    ]);
  });

  it('falls back to the display name when an executable stem is unavailable', () => {
    expect(
      mergeProjectEditors([{ id: 'vscode', name: 'VS Code' }], [{ id: 'custom', name: 'VS Code' }]),
    ).toEqual([{ id: 'custom', name: 'VS Code', custom: true }]);
  });
});
