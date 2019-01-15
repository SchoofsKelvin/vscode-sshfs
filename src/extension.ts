
import * as vscode from 'vscode';
import { invalidConfigName, loadConfigs } from './config';
import { Manager } from './manager';

async function pickConfig(manager: Manager, activeOrNot?: boolean) {
  let names = manager.getActive();
  const others = loadConfigs();
  if (activeOrNot === false) {
    names = others.filter(c => !names.find(cc => cc.name === c.name));
  } else if (activeOrNot === undefined) {
    others.forEach(n => names.indexOf(n) === -1 && names.push(n));
  }
  const options: vscode.QuickPickItem[] = names.map(config => ({
    label: config.label || config.username + '@' + config.host,
    description: config.root,
    detail: config.name
  }));
  const pick = await vscode.window.showQuickPick(options, { placeHolder: 'SSH FS Configuration' });
  return pick && pick.detail;
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
    const name = await vscode.window.showInputBox({ placeHolder: 'Name for the new SSH file system', validateInput: invalidConfigName });
    if (name) vscode.window.showTextDocument(vscode.Uri.parse(`ssh://<config>/${name}.sshfs.jsonc`), { preview: false });
  });

  registerCommand('sshfs.connect', (name?: string) => pickAndClick(manager.commandConnect, name, false));
  registerCommand('sshfs.disconnect', (name?: string) => pickAndClick(manager.commandDisconnect, name, true));
  registerCommand('sshfs.reconnect', (name?: string) => pickAndClick(manager.commandReconnect, name, true));
  registerCommand('sshfs.configure', (name?: string) => pickAndClick(manager.commandConfigure, name));
  registerCommand('sshfs.delete', (name?: string) => pickAndClick(manager.commandDelete, name));

  vscode.window.createTreeView('sshfs-configs', { treeDataProvider: manager });
}
