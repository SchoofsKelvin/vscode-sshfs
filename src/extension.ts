
import * as vscode from 'vscode';
import { invalidConfigName, loadConfigs, renameNameless } from './config';
import * as Logging from './logging';
import { Manager } from './manager';

async function pickConfig(manager: Manager, activeOrNot?: boolean) {
  await renameNameless();
  let names = manager.getActive();
  const others = loadConfigs();
  if (activeOrNot === false) {
    names = others.filter(c => !names.find(cc => cc.name === c.name));
  } else if (activeOrNot === undefined) {
    others.forEach(n => !names.find(c => c.name === n.name) && names.push(n));
  }
  const options: vscode.QuickPickItem[] = names.map(config => ({
    label: config.label || config.name,
    description: config.label && config.name,
  }));
  const pick = await vscode.window.showQuickPick(options, { placeHolder: 'SSH FS Configuration' });
  return pick && pick.detail;
}

export function activate(context: vscode.ExtensionContext) {
  Logging.info('Extension activated');

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
    await renameNameless();
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
