// Reuse the real browser adapter with synthetic backup and update records for UI review.
export * from '../ospanel';
export { requestAppConfirm as askConfirm } from '../ospanel';

import type { AppUpdate, BackupEntry, BackupKind, ModuleUpdate } from '../ospanel';
import { demoText } from './runtime';

// Synthetic update data makes the complete release dialog reviewable without network or native writes.
export async function checkAppUpdate(): Promise<AppUpdate> {
  return {
    version: '0.7.1',
    notes: demoText('demo.releaseNotes'),
    publishedAt: '2026-11-17T10:00:00Z',
    size: 18600000,
    url: 'https://downloads.example/OSP_Control_preview.zip',
    sha256: '0'.repeat(64),
  };
}
export async function checkModuleUpdates(): Promise<ModuleUpdate[]> {
  return [
    {
      name: 'Apache',
      installed: '2.4.62',
      available: '2.4.63',
      expected: '2.4.63',
      error: null,
      recovery: false,
    },
    {
      name: 'PHP',
      installed: '8.3.14',
      available: null,
      expected: null,
      error: 'err.phpUnsupported',
      recovery: false,
    },
  ];
}

let backups: BackupEntry[] = [
  {
    id: 'demo-config.zip',
    kind: 'config',
    subject: null,
    createdAt: 1768471200,
    sizeBytes: 124000,
    files: 8,
  },
  {
    id: 'demo-database.sql',
    kind: 'db',
    subject: 'MySQL',
    createdAt: 1768471000,
    sizeBytes: 2400000,
    files: 1,
  },
  {
    id: 'demo-project.zip',
    kind: 'project',
    subject: 'my-shop.test',
    createdAt: 1768470800,
    sizeBytes: 18600000,
    files: 64,
  },
  { id: 'demo-menu.dat', kind: 'menu', subject: null, createdAt: 1768470600, sizeBytes: 8200, files: 1 },
];
export async function listBackups(): Promise<BackupEntry[]> {
  return structuredClone(backups);
}
async function addBackup(kind: BackupKind, subject: string | null = null): Promise<BackupEntry> {
  const entry = {
    id: `demo-${crypto.randomUUID()}`,
    kind,
    subject,
    createdAt: Math.floor(Date.now() / 1000),
    sizeBytes: 24000,
    files: 1,
  };
  backups = [entry, ...backups];
  return entry;
}
export const createBackup = () => addBackup('config');
export const createMenuBackup = () => addBackup('menu');
export const createDbBackup = (module: string) => addBackup('db', module);
export const createProjectBackup = (domain: string) => addBackup('project', domain);
export async function deleteBackup(id: string) {
  backups = backups.filter((entry) => entry.id !== id);
}

// Restoration remains an in-memory preview, including the automatic safety backup.
export async function restoreBackup() {
  await addBackup('config');
}
export async function restoreMenuBackup() {
  await addBackup('menu');
}
export async function restoreDbBackup() {
  await addBackup('db', 'MySQL');
}
export async function restoreProjectBackup() {
  await addBackup('project', 'my-shop.test');
}
