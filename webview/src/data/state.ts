import { FileSystemConfig } from '../../../src/fileSystemConfig';

export interface IState {
  configs: FileSystemConfig[];
}

export const DEFAULT_STATE: IState = {
  configs: [],
}
