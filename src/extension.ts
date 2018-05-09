
import * as fs from 'fs';
import * as vscode from 'vscode';
import { MemFs } from './fileSystemProvider';
import { Manager } from './manager';

const workspace = vscode.workspace;

async function pickConfig(manager: Manager, activeOrNot?: boolean) {
  let names = manager.getActive();
  const others = manager.loadConfigs().map(c => c.name);
  if (activeOrNot === false) {
    names = others.filter(n => names.indexOf(n) === -1);
  } else if (activeOrNot === undefined) {
    others.forEach(n => names.indexOf(n) === -1 && names.push(n));
  }
  return vscode.window.showQuickPick(names, { placeHolder: 'SSH FS Configuration' });
}

export function activate(context: vscode.ExtensionContext) {
  const manager = new Manager(context);

  const subscribe = context.subscriptions.push.bind(context.subscriptions) as typeof context.subscriptions.push;
  const registerCommand = (command: string, callback: (...args: any[]) => any, thisArg?: any) =>
    subscribe(vscode.commands.registerCommand(command, callback, thisArg));

  subscribe(vscode.workspace.registerFileSystemProvider('ssh', manager, { isCaseSensitive: true }));

  async function pickAndClick(func: (name: string) => void, name?: string, activeOrNot?: boolean) {
    name = name || await pickConfig(manager, activeOrNot);
    if (name) func.call(manager, name);
  }

  registerCommand('sshfs.new', async () => {
    const name = await vscode.window.showInputBox({ placeHolder: 'Name for the new SSH file system', validateInput: manager.invalidConfigName.bind(manager) });
    if (name) vscode.window.showTextDocument(vscode.Uri.parse(`ssh://<config>/${name}.sshfs.jsonc`), { preview: false });
  });

  registerCommand('sshfs.connect', (name?: string) => pickAndClick(manager.commandConnect, name, false));
  registerCommand('sshfs.disconnect', (name?: string) => pickAndClick(manager.commandDisconnect, name, true));
  registerCommand('sshfs.reconnect', (name?: string) => pickAndClick(manager.commandReconnect, name, true));
  registerCommand('sshfs.configure', (name?: string) => pickAndClick(manager.commandConfigure, name));
  registerCommand('sshfs.delete', (name?: string) => pickAndClick(manager.commandConfigDelete, name));

  vscode.window.createTreeView('sshfs-configs', { treeDataProvider: manager });
}
