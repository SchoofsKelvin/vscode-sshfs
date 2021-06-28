
import * as vscode from 'vscode';
import { loadConfigs } from './config';
import type { Connection } from './connection';
import type { FileSystemConfig } from './fileSystemConfig';
import { FileSystemRouter } from './fileSystemRouter';
import { Logging, setDebug } from './logging';
import { Manager } from './manager';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import { ConfigTreeProvider, ConnectionTreeProvider } from './treeViewManager';
import { pickComplex, PickComplexOptions, pickConnection, setAsAbsolutePath, setupWhenClauseContexts } from './ui-utils';

function getVersion(): string | undefined {
  const ext = vscode.extensions.getExtension('Kelvin.vscode-sshfs');
  return ext?.packageJSON?.version;
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
  Logging.info(`Extension activated, version ${getVersion()}, mode ${context.extensionMode}`);

  setDebug(context.extensionMode !== vscode.ExtensionMode.Production);

  // Likely that we'll have a breaking change in the future that requires users to check
  // their configs, or at least reconfigure already existing workspaces with new URIs.
  // See https://github.com/SchoofsKelvin/vscode-sshfs/issues/198#issuecomment-785926352
  const previousVersion = context.globalState.get<string>('lastVersion');
  context.globalState.update('lastVersion', getVersion());
  if (!previousVersion) {
    Logging.info('No previous version detected. Fresh or pre-v1.21.0 installation?');
  } else if (previousVersion !== getVersion()) {
    Logging.info(`Previously used version ${previousVersion}, first run after install.`);
  }

  // Really too bad we *need* the ExtensionContext for relative resources
  // I really don't like having to pass context to *everything*, so let's do it this way
  setAsAbsolutePath(context.asAbsolutePath.bind(context));

  const manager = new Manager(context);

  const subscribe = context.subscriptions.push.bind(context.subscriptions) as typeof context.subscriptions.push;
  const registerCommand = (command: string, callback: (...args: any[]) => any, thisArg?: any) =>
    subscribe(vscode.commands.registerCommand(command, callback, thisArg));

  subscribe(vscode.workspace.registerFileSystemProvider('ssh', new FileSystemRouter(manager), { isCaseSensitive: true }));
  subscribe(vscode.window.createTreeView('sshfs-configs', { treeDataProvider: new ConfigTreeProvider(), showCollapseAll: true }));
  const connectionTreeProvider = new ConnectionTreeProvider(manager.connectionManager);
  subscribe(vscode.window.createTreeView('sshfs-connections', { treeDataProvider: connectionTreeProvider, showCollapseAll: true }));
  subscribe(vscode.tasks.registerTaskProvider('ssh-shell', manager));
  subscribe(vscode.window.registerTerminalLinkProvider(manager));

  setupWhenClauseContexts(manager.connectionManager);

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
    promptOptions: { promptConfigs: true, promptConnections: true, promptInstantConnection: true },
    handleConfig: config => manager.commandConnect(config),
  });

  // sshfs.disconnect(target: string | FileSystemConfig | Connection)
  registerCommandHandler('sshfs.disconnect', {
    promptOptions: { promptConnections: true },
    handleString: name => manager.commandDisconnect(name),
    handleConfig: config => manager.commandDisconnect(config.name),
    handleConnection: con => manager.commandDisconnect(con),
  });

  // sshfs.disconnectAll()
  registerCommand('sshfs.disconnectAll', () => {
    const conns = manager.connectionManager;
    // Does not close pending connections (yet?)
    conns.getActiveConnections().forEach(conn => conns.closeConnection(conn, 'command:disconnectAll'));
  });

  // sshfs.terminal(target?: FileSystemConfig | Connection | vscode.Uri)
  registerCommandHandler('sshfs.terminal', {
    promptOptions: { promptConfigs: true, promptConnections: true, promptInstantConnection: true },
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

  // sshfs.refresh()
  registerCommand('sshfs.refresh', () => connectionTreeProvider.refresh());
}
