import { ConfigLocation, FileSystemConfig } from './fileSystemConfig';

export interface RequestDataMessage {
  type: 'requestData';
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

export interface MessageTypes {
  requestData: RequestDataMessage;
  responseData: ResponseDataMessage;
  saveConfig: SaveConfigMessage;
  saveConfigResult: SaveConfigResultMessage;
  promptPath: PromptPathMessage;
  promptPathResult: PromptPathResultMessage;
}

export type Message = MessageTypes[keyof MessageTypes];
