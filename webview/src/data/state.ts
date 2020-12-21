import type { ConfigLocation, FileSystemConfig } from '../types/fileSystemConfig';

export interface IState {
  configs: FileSystemConfig[];
  locations: ConfigLocation[];
}

export const DEFAULT_STATE: IState = {
  configs: [],
  locations: [],
}
