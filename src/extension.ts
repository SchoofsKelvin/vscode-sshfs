
import * as vscode from 'vscode';
import { loadConfigs } from './config';
import { FileSystemConfig, invalidConfigName } from './fileSystemConfig';
import * as Logging from './logging';
import { Manager } from './manager';
import { SearchProvider } from './searchProvider';

function generateDetail(config: FileSystemConfig): string | undefined {
  const { username, host, putty } = config;
  const port = config.port && config.port !== 22 ? `:${config.port}` : '';
  if (putty) {
    if (typeof putty === 'string') return `PuTTY session "${putty}"`;
    return 'PuTTY session (deduced from config)';
  } else if (!host) {
    return undefined;
  } else if (username) {
    return `${username}@${host}${port}`;
  }
  return `${host}${port}`;
}

async function pickConfig(manager: Manager, activeOrNot?: boolean): Promise<string | undefined> {
  let names = manager.getActive();
  const others = await loadConfigs();
  if (activeOrNot === false) {
    names = others.filter(c => !names.find(cc => cc.name === c.name));
  } else if (activeOrNot === undefined) {
    others.forEach(n => !names.find(c => c.name === n.name) && names.push(n));
  }
  const options: (vscode.QuickPickItem & { name: string })[] = names.map(config => ({
    name: config.name,
    description: config.name,
    label: config.label || config.name,
    detail: generateDetail(config),
  }));
  const pick = await vscode.window.showQuickPick(options, { placeHolder: 'SSH FS Configuration' });
  return pick && pick.name;
}

function getVersion(): string | undefined {
  const ext = vscode.extensions.getExtension('Kelvin.vscode-sshfs');
  return ext && ext.packageJSON && ext.packageJSON.version;
}

export function activate(context: vscode.ExtensionContext) {
  Logging.info(`Extension activated, version ${getVersion()}`);

  const manager = new Manager(context);

  const subscribe = context.subscriptions.push.bind(context.subscriptions) as typeof context.subscriptions.push;
  const registerCommand = (command: string, callback: (...args: any[]) => any, thisArg?: any) =>
    subscribe(vscode.commands.registerCommand(command, callback, thisArg));

  subscribe(vscode.workspace.registerFileSystemProvider('ssh', manager, { isCaseSensitive: true }));
  subscribe(vscode.workspace.registerFileSearchProvider('ssh', new SearchProvider(manager)));

  async function pickAndClick(func: (name: string) => void, name?: string, activeOrNot?: boolean) {
    name = name || await pickConfig(manager, activeOrNot);
    if (name) func.call(manager, name);
  }

  registerCommand('sshfs.new', async () => manager.openSettings({ type: 'newconfig' }));
  registerCommand('sshfs.settings', () => manager.openSettings());

  registerCommand('sshfs.connect', (name?: string) => pickAndClick(manager.commandConnect, name, false));
  registerCommand('sshfs.disconnect', (name?: string) => pickAndClick(manager.commandDisconnect, name, true));
  registerCommand('sshfs.reconnect', (name?: string) => pickAndClick(manager.commandReconnect, name, true));
  registerCommand('sshfs.configure', (name?: string) => pickAndClick(manager.commandConfigure, name));

  registerCommand('sshfs.reload', loadConfigs);

  vscode.window.createTreeView('sshfs-configs', { treeDataProvider: manager });
}
