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
export function error(message: string) {
  outputChannel.appendLine(`[ERROR] ${message}`);
}

export function censorConfig(config: FileSystemConfig): FileSystemConfig {
  return {
    ...config,
    password: typeof config.password === 'string' ? '<censored>' : config.password,
    passphrase: typeof config.passphrase === 'string' ? '<censored>' : config.passphrase,
  };
}

info('Created output channel for vscode-sshfs');
