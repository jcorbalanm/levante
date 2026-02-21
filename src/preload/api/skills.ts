import { ipcRenderer } from 'electron';
import type {
  SkillBundleResponse,
  SkillsCatalogResponse,
  SkillCategory,
  InstalledSkill,
  IPCResult,
} from '../../types/skills';

export const skillsApi = {
  getCatalog: (): Promise<IPCResult<SkillsCatalogResponse>> =>
    ipcRenderer.invoke('levante/skills:getCatalog'),

  getCategories: (): Promise<IPCResult<{ categories: SkillCategory[] }>> =>
    ipcRenderer.invoke('levante/skills:getCategories'),

  getBundle: (skillId: string): Promise<IPCResult<SkillBundleResponse>> =>
    ipcRenderer.invoke('levante/skills:getBundle', skillId),

  install: (skill: SkillBundleResponse): Promise<IPCResult<InstalledSkill>> =>
    ipcRenderer.invoke('levante/skills:install', skill),

  uninstall: (skillId: string): Promise<IPCResult<boolean>> =>
    ipcRenderer.invoke('levante/skills:uninstall', skillId),

  listInstalled: (): Promise<IPCResult<InstalledSkill[]>> =>
    ipcRenderer.invoke('levante/skills:listInstalled'),

  isInstalled: (skillId: string): Promise<IPCResult<boolean>> =>
    ipcRenderer.invoke('levante/skills:isInstalled', skillId),
};
