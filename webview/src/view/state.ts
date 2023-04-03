import type { ConfigLocation, FileSystemConfig } from 'common/fileSystemConfig';

interface IViewState<V extends string> {
  view: V;
}

export interface IStartScreenState extends IViewState<'startscreen'> {
  groupBy: string;
}

export interface INewConfigState extends IViewState<'newconfig'> {
  location?: ConfigLocation;
  name: string;
}

export interface IConfigEditorState extends IViewState<'configeditor'> {
  oldConfig: FileSystemConfig;
  newConfig: FileSystemConfig;
  statusMessage?: string;
}

export interface IConfigLocatorState extends IViewState<'configlocator'> {
  configs: FileSystemConfig[];
  name: string;
}

export type IState = IStartScreenState | INewConfigState | IConfigEditorState | IConfigLocatorState;

export const DEFAULT_STATE: IState = {
  groupBy: 'group',
  view: 'startscreen',
}
