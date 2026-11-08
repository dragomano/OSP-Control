export type ModuleProfile = { name: string; builtin: boolean; hasData: boolean };
export type ModuleProfiles = {
  active: string;
  online: boolean;
  profiles: ModuleProfile[];
  factoryAvailable: boolean;
  factoryData: boolean;
};
export type ProfileFile = { name: string; sizeBytes: number };
export type ProfileDocument = { files: ProfileFile[]; path: string };
export type ProfileSave = { content: string; backupPath: string };

export function validProfileName(name: string): boolean {
  return (
    /^[A-Za-z0-9_+.-]{1,100}$/.test(name) &&
    !name.startsWith('.') &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}

export function profileNameExists(profiles: ModuleProfile[], name: string): boolean {
  return profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase());
}
