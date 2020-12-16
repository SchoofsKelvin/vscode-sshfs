
import * as vscode from 'vscode';
import { loadConfigs } from './config';
import type { Connection } from './connection';
import type { FileSystemConfig } from './fileSystemConfig';
import { FileSystemRouter } from './fileSystemRouter';
import { Logging } from './logging';
import { Manager } from './manager';
import type { SSHPseudoTerminal } from './pseudoTerminal';

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

async function pickConfig(manager: Manager, activeFileSystem?: boolean): Promise<string | undefined> {
  let fsConfigs = manager.getActiveFileSystems().map(fs => fs.config).map(c => c._calculated || c);
  const others = await loadConfigs();
  if (activeFileSystem === false) {
    fsConfigs = others.filter(c => !fsConfigs.find(cc => cc.name === c.name));
  } else if (activeFileSystem === undefined) {
    others.forEach(n => !fsConfigs.find(c => c.name === n.name) && fsConfigs.push(n));
  }
  const options: (vscode.QuickPickItem & { name: string })[] = fsConfigs.map(config => ({
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

interface CommandHandler {
  /** If set, a string/undefined prompts using the given options.
   * If the input was a string, promptOptions.nameFilter is set to it */
  promptOptions: PickComplexOptions;
  handleString?(string: string): void;
  handleUri?(uri: vscode.Uri): void;
  handleConfig?(config: FileSystemConfig): void;
  handleConnection?(connection: Connection): void;
  handleTerminal?(terminal: SSHPseudoTerminal): void;
}

export function activate(context: vscode.ExtensionContext) {
  Logging.info(`Extension activated, version ${getVersion()}`);

  const manager = new Manager(context);

  const subscribe = context.subscriptions.push.bind(context.subscriptions) as typeof context.subscriptions.push;
  const registerCommand = (command: string, callback: (...args: any[]) => any, thisArg?: any) =>
    subscribe(vscode.commands.registerCommand(command, callback, thisArg));

  subscribe(vscode.workspace.registerFileSystemProvider('ssh', new FileSystemRouter(manager), { isCaseSensitive: true }));
  subscribe(vscode.window.createTreeView('sshfs-configs', { treeDataProvider: manager, showCollapseAll: true }));
  subscribe(vscode.tasks.registerTaskProvider('ssh-shell', manager));

  function registerCommandHandler(name: string, handler: CommandHandler) {
    const callback = async (arg?: string | FileSystemConfig | Connection | SSHPseudoTerminal | vscode.Uri) => {
      if (handler.promptOptions && (!arg || typeof arg === 'string')) {
        arg = await pickComplex(manager, { ...handler.promptOptions, nameFilter: arg });
      }
      if (typeof arg === 'string') return handler.handleString?.(arg);
      if (!arg) return;
      if (arg instanceof vscode.Uri) {
        return handler.handleUri?.(arg);
      } else if ('handleInput' in arg) {
        return handler.handleTerminal?.(arg);
      } else if ('client' in arg) {
        return handler.handleConnection?.(arg);
      } else if ('name' in arg) {
        return handler.handleConfig?.(arg);
      }
      Logging.warning(`CommandHandler for '${name}' could not handle input '${arg}'`);
    };
    registerCommand(name, callback);
  }

  // sshfs.new()
  registerCommand('sshfs.new', () => manager.openSettings({ type: 'newconfig' }));

  // sshfs.add(target?: string | FileSystemConfig)
  registerCommandHandler('sshfs.add', {
    promptOptions: { promptConfigs: true },
    handleConfig: config => manager.commandConnect(config),
  });

  // sshfs.disconnect(target: string | FileSystemConfig | Connection)
  registerCommandHandler('sshfs.disconnect', {
    promptOptions: { promptConfigs: true, promptConnections: true },
    handleString: name => manager.commandDisconnect(name),
    handleConfig: config => manager.commandDisconnect(config.name),
    handleConnection: con => manager.commandDisconnect(con),
  });

  // sshfs.termninal(target?: string | FileSystemConfig | Connection | vscode.Uri)
  registerCommandHandler('sshfs.terminal', {
    promptOptions: { promptConfigs: true, promptConnections: true },
    handleConfig: config => manager.commandTerminal(config),
    handleConnection: con => manager.commandTerminal(con),
    handleUri: async uri => {
      const con = await pickConnection(manager, uri.authority);
      con && manager.commandTerminal(con, uri);
    },
  });

  // sshfs.focusTerminal(target?: SSHPseudoTerminal)
  registerCommandHandler('sshfs.focusTerminal', {
    promptOptions: { promptTerminals: true },
    handleTerminal: ({ terminal }) => terminal?.show(false),
  });

  // sshfs.closeTerminal(target?: SSHPseudoTerminal)
  registerCommandHandler('sshfs.closeTerminal', {
    promptOptions: { promptTerminals: true },
    handleTerminal: terminal => terminal.close(),
  });

  // sshfs.configure(target?: string | FileSystemConfig)
  registerCommandHandler('sshfs.configure', {
    promptOptions: { promptConfigs: true },
    handleConfig: config => manager.commandConfigure(config),
  });

  // sshfs.reload()
  registerCommand('sshfs.reload', loadConfigs);

  // sshfs.settings()
  registerCommand('sshfs.settings', () => manager.openSettings());
}
