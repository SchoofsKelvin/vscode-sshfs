import type { ConfigLocation, FileSystemConfig } from 'common/fileSystemConfig';

export enum ActionType {
  RECEIVED_DATA = 'RECEIVED_DATA',
}

interface IAction {
  type: ActionType;
}

export type Action = IActionReceivedConfigs;

export interface IActionReceivedConfigs extends IAction {
  configs: FileSystemConfig[];
  locations: ConfigLocation[];
}
export function receivedData(configs: FileSystemConfig[], locations: ConfigLocation[]): IActionReceivedConfigs {
  return { configs, locations, type: ActionType.RECEIVED_DATA };
}
