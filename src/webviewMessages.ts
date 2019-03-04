import { FileSystemConfig } from './fileSystemConfig';

export interface RequestDataMessage {
  type: 'requestData';
}
export interface ResponseDataMessage {
  type: 'responseData';
  configs: FileSystemConfig[];
}

export interface MessageTypes {
  requestData: RequestDataMessage;
  responseData: ResponseDataMessage;
}

export type Message = MessageTypes[keyof MessageTypes];
