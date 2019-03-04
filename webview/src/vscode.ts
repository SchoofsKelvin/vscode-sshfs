
import { Message, MessageTypes } from './types';


interface VSCodeAPI {
  postMessage(msg: Message): void;
  setState(state: any): void;
  getState<T>(): T | undefined;
}

declare const acquireVsCodeApi: () => VSCodeAPI;
export const API: VSCodeAPI = acquireVsCodeApi();

export type Listener<T extends Message = Message> = (message: T) => void;
export type Filter = string | ((message: Message) => boolean);
let LISTENERS: Array<[Listener, Filter | undefined]> = [];

export function addListener(listener: Listener): void;
export function addListener<T extends Message, K extends Message['type']>(listener: Listener<MessageTypes[K]>, filter: K): void;
export function addListener<T extends Message = Message>(listener: Listener<T>, filter?: Filter): void;
export function addListener(listener: Listener, filter?: Filter) {
  LISTENERS.push([listener, filter]);
}
export function removeListener(listener: Listener) {
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
      console.error(`Error in message handler:\n${e}\nMessage:${message}`);
    }
  }
});
