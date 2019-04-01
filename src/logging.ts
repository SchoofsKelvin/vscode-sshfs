import * as vscode from 'vscode';
import { FileSystemConfig } from './fileSystemConfig';

const outputChannel = vscode.window.createOutputChannel('ssh-fs');

export function debug(message: string) {
  outputChannel.appendLine(`[DEBUG] ${message}`);
}
export function info(message: string) {
  outputChannel.appendLine(`[INFO] ${message}`);
}
export function warning(message: string) {
  outputChannel.appendLine(`[WARNING] ${message}`);
}
export function error(message: string | Error) {
  if (message instanceof Error && message.stack) {
    message = `${message.message}\n${message.stack}`;
  }
  outputChannel.appendLine(`[ERROR] ${message}`);
}

export function censorConfig(config: FileSystemConfig): FileSystemConfig {
  return {
    ...config,
    password: typeof config.password === 'string' ? '<censored>' : config.password,
    passphrase: typeof config.passphrase === 'string' ? '<censored>' : config.passphrase,
    privateKey: config.privateKey instanceof Buffer ? `Buffer(${config.privateKey.length})` : config.privateKey,
  };
}

info('Created output channel for vscode-sshfs');
