import { FileSystemConfig } from 'src/types';

export enum ActionType {
  RECEIVED_CONFIGS = 'RECEIVED_CONFIGS',
}

interface IAction {
  type: ActionType;
}

export type Action = IActionReceivedConfigs

export interface IActionReceivedConfigs extends IAction {
  configs: FileSystemConfig[];
}
export function receivedConfigs(configs: FileSystemConfig[]): IActionReceivedConfigs {
  return { configs, type: ActionType.RECEIVED_CONFIGS };
}