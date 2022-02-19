
import type { ConfigLocation, FileSystemConfig } from 'common/fileSystemConfig';
import type { Message, MessageTypes, PromptPathResultMessage, SaveConfigResultMessage } from 'common/webviewMessages';

interface VSCodeAPI {
  postMessage(msg: Message): void;
  setState(state: any): void;
  getState<T>(): T | undefined;
}

declare const acquireVsCodeApi: () => VSCodeAPI;
export const API: VSCodeAPI = acquireVsCodeApi();

export type Listener<T extends Message = Message> = (message: T) => void;
export type Filter = string | ((message: Message) => boolean);
let LISTENERS: [Listener, Filter | undefined][] = [];

export function addListener(listener: Listener): void;
export function addListener<K extends Message['type']>(listener: Listener<MessageTypes[K]>, filter: K): void;
export function addListener<T extends Message = Message>(listener: Listener<T>, filter: Exclude<Filter, string>): void;
export function addListener(listener: Listener, filter?: Filter) {
  LISTENERS.push([listener, filter]);
}
export function removeListener<T extends Message = Message>(listener: Listener<T>) {
  LISTENERS = LISTENERS.filter(([l]) => l !== listener);
}

window.addEventListener('message', event => {
  console.log('MESSAGE', event);
  const message: Message = event.data;
  if (!message || !message.type) return;
  for (const [listener, filter] of LISTENERS) {
    if (typeof filter === 'string') {
      if (filter !== message.type) continue;
    } else if (filter && !filter(message)) {
      continue;
    }
    try {
      listener(message);
    } catch (e) {
      console.error('Error in message handler', e, message);
    }
  }
});

export function createConfig(name: string, location: ConfigLocation): Promise<FileSystemConfig> {
  return new Promise<FileSystemConfig>((resolve, reject) => {
    const uniqueId = `${name}-${Date.now()};`
    function handler(message: SaveConfigResultMessage) {
      if (message.uniqueId !== uniqueId) return;
      removeListener(handler);
      if (message.error) return reject(message.error);
      resolve(message.config);
    }
    addListener(handler, 'saveConfigResult');
    const config: FileSystemConfig = { name, _location: location, _locations: [location] };
    API.postMessage({ type: 'saveConfig', config, uniqueId });
  });
}

export function saveConfig(config: FileSystemConfig, name?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const uniqueId = `${config.name}-${Date.now()};`
    function handler(message: SaveConfigResultMessage) {
      if (message.uniqueId !== uniqueId) return;
      removeListener(handler);
      if (message.error) return reject(message.error);
      resolve();
    }
    addListener(handler, 'saveConfigResult');
    API.postMessage({ type: 'saveConfig', config, uniqueId, name });
  });
}

export function deleteConfig(config: FileSystemConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const uniqueId = `${config.name}-${Date.now()};`
    function handler(message: SaveConfigResultMessage) {
      if (message.uniqueId !== uniqueId) return;
      removeListener(handler);
      if (message.error) return reject(message.error);
      resolve();
    }
    addListener(handler, 'saveConfigResult');
    API.postMessage({ type: 'saveConfig', config, uniqueId, remove: true });
  });
}

export function promptPath(): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const uniqueId = Date.now().toString();
    function handler(message: PromptPathResultMessage) {
      if (message.uniqueId !== uniqueId) return;
      removeListener(handler);
      if (message.error) return reject(message.error);
      resolve(message.path);
    }
    addListener(handler, 'promptPathResult');
    API.postMessage({ type: 'promptPath', uniqueId });
  });
}
