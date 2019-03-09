import { ConfigLocation, FileSystemConfig } from 'src/types/fileSystemConfig';

interface IViewState<V extends string> {
  view: V;
}

export type IStartScreenState = IViewState<'startscreen'>;

export interface INewConfigState extends IViewState<'newconfig'> {
  locations: ConfigLocation[];
  location: ConfigLocation;
  name: string;
}

export interface IConfigEditorState extends IViewState<'configeditor'> {
  oldConfig: FileSystemConfig;
  newConfig: FileSystemConfig;
  statusMessage?: string;
}

export type IState = IStartScreenState | INewConfigState | IConfigEditorState;

export const DEFAULT_STATE: IState = {
  view: 'startscreen',
}
