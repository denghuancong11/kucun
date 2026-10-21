import type { Role } from '../types';

export const operationGroups: Partial<Record<Role,string>> = {'operation-1':'一团','operation-2':'二团','assistant-1':'一团','assistant-2':'二团'};

const transitSourceTeams: Record<string, string> = { '一团': '一团', '二团': '二团', '一团三部': '一团' };
export function transitSourceTeam(department: string | undefined) {
  const name = department?.trim() ?? '';
  return Object.prototype.hasOwnProperty.call(transitSourceTeams, name) ? transitSourceTeams[name] : '';
}
