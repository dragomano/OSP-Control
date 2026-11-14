import { invoke } from '@tauri-apps/api/core';
import { isDesktopApp } from './ospanel';
import { DEFAULT_STARTERS, type ProjectStarterDocument, type StarterEntry } from './projectTemplates';

const demo = new Map(DEFAULT_STARTERS.map((doc) => [doc.manifest.id, structuredClone(doc)]));
export async function listProjectStarters(): Promise<StarterEntry[]> {
  if (isDesktopApp()) return invoke('list_project_starters');
  return [...demo.values()].map((document) => ({
    id: document.manifest.id,
    document: structuredClone(document),
    error: null,
  }));
}
export async function saveProjectStarter(starter: ProjectStarterDocument): Promise<ProjectStarterDocument> {
  if (isDesktopApp()) return invoke('save_project_starter', { starter });
  const saved = structuredClone({ ...starter, revision: String(Date.now()) });
  demo.set(starter.manifest.id, saved);
  return saved;
}
export async function deleteProjectStarter(starter: ProjectStarterDocument): Promise<void> {
  if (isDesktopApp())
    return invoke('delete_project_starter', { id: starter.manifest.id, revision: starter.revision });
  demo.delete(starter.manifest.id);
}
export async function restoreDefaultProjectStarters(id?: string): Promise<void> {
  if (isDesktopApp()) return invoke('restore_default_project_starters', { id: id ?? null });
  for (const doc of DEFAULT_STARTERS)
    if (!id || doc.manifest.id === id) demo.set(doc.manifest.id, structuredClone(doc));
}
export async function openProjectStartersFolder(): Promise<void> {
  if (isDesktopApp()) return invoke('open_project_starters_folder');
}
