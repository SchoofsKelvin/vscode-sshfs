import type { ConfigLocation, FileSystemConfig } from './fileSystemConfig';

/* Type of messages*/

export interface RequestDataMessage {
  type: 'requestData';
  reload?: boolean;
}
export interface ResponseDataMessage {
  type: 'responseData';
  configs: FileSystemConfig[];
  locations: ConfigLocation[];
}

export interface SaveConfigMessage {
  type: 'saveConfig';
  config: FileSystemConfig;
  name?: string;
  uniqueId?: string;
  remove?: boolean;
}
export interface SaveConfigResultMessage {
  type: 'saveConfigResult';
  error?: string;
  config: FileSystemConfig;
  uniqueId?: string;
}

export interface PromptPathMessage {
  type: 'promptPath';
  uniqueId?: string;
}
export interface PromptPathResultMessage {
  type: 'promptPathResult';
  error?: string;
  path?: string;
  uniqueId?: string;
}

export interface NavigateMessage {
  type: 'navigate';
  navigation: Navigation;
}
export interface NavigatedMessage {
  type: 'navigated';
  view: string;
}

export interface MessageTypes {
  requestData: RequestDataMessage;
  responseData: ResponseDataMessage;
  saveConfig: SaveConfigMessage;
  saveConfigResult: SaveConfigResultMessage;
  promptPath: PromptPathMessage;
  promptPathResult: PromptPathResultMessage;
  navigate: NavigateMessage;
  navigated: NavigatedMessage;
}

export type Message = MessageTypes[keyof MessageTypes];

/* Types related to NavigateMessage */

export interface NewConfigNavigation {
  type: 'newconfig';
}
export interface EditConfigNavigation {
  type: 'editconfig';
  config: FileSystemConfig | FileSystemConfig[];
}
export type Navigation = NewConfigNavigation | EditConfigNavigation;
