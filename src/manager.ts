
import * as path from 'path';
import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { getConfig, getConfigs, loadConfigsRaw, UPDATE_LISTENERS } from './config';
import { FileSystemConfig, getGroups } from './fileSystemConfig';
import { Logging } from './logging';
import type { SSHFileSystem } from './sshFileSystem';
import { catchingPromise, toPromise } from './toPromise';
import type { Navigation } from './webviewMessages';
import { Connection, ConnectionManager } from './connection';

export enum ConfigStatus {
  Idle = 'Idle',
  Active = 'Active',
  Deleted = 'Deleted',
  Connecting = 'Connecting',
  Error = 'Error',
}

function createTreeItem(manager: Manager, item: string | FileSystemConfig): vscode.TreeItem {
  if (typeof item === 'string') {
    return {
      label: item.replace(/^.+\./, ''),
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    };
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const isConnected = folders.some(f => f.uri.scheme === 'ssh' && f.uri.authority === item.name);
  const status = manager.getStatus(item.name);
  return {
    label: item && item.label || item.name,
    contextValue: isConnected ? 'active' : 'inactive',
    tooltip: status === 'Deleted' ? 'Active but deleted' : status,
    iconPath: manager.context.asAbsolutePath(`resources/config/${status}.png`),
  };
}

async function tryGetHome(ssh: Client): Promise<string | null> {
  const exec = await toPromise<ClientChannel>(cb => ssh.exec('echo Home: ~', cb));
  const { MemoryDuplex } = await import('./streams');
  const stdout = new MemoryDuplex();
  exec.stdout.pipe(stdout);
  await toPromise(cb => exec.on('close', cb));
  const home = stdout.read().toString();
  if (!home) return null;
  const mat = home.match(/^Home: (.*?)\r?\n?$/);
  if (!mat) return null;
  return mat[1];
}

function commandArgumentToName(arg?: string | FileSystemConfig | Connection): string {
  if (!arg) return 'undefined';
  if (typeof arg === 'string') return arg;
  if ('client' in arg) return `Connection(${arg.actualConfig.name})`;
  return `FileSystemConfig(${arg.name})`;
}

interface SSHShellTaskOptions {
  host: string;
  command: string;
  workingDirectory?: string;
}

export class Manager implements vscode.TreeDataProvider<string | FileSystemConfig>, vscode.TaskProvider {
  public onDidChangeTreeData: vscode.Event<string | null>;
  protected fileSystems: SSHFileSystem[] = [];
  protected creatingFileSystems: { [name: string]: Promise<SSHFileSystem> } = {};
  protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<string | null>();
  protected connectionManager = new ConnectionManager();
  constructor(public readonly context: vscode.ExtensionContext) {
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    // In a multi-workspace environment, when the non-main folder gets removed,
    // it might be one of ours, which we should then disconnect if it's
    // the only one left for the given config (name)
    // When one gets added, it gets connected on-demand (using stat() etc)
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      const { workspaceFolders = [] } = vscode.workspace;
      e.removed.forEach(async (folder) => {
        if (folder.uri.scheme !== 'ssh') return;
        if (workspaceFolders.find(f => f.uri.authority === folder.uri.authority)) return;
        this.commandDisconnect(folder.uri.authority);
      });
      this.onDidChangeTreeDataEmitter.fire(null);
    });
    UPDATE_LISTENERS.push(() => this.fireConfigChanged());
  }
  public fireConfigChanged(): void {
    this.onDidChangeTreeDataEmitter.fire(null);
    // TODO: Offer to reconnect everything
  }
  /** This purely looks at whether a filesystem with the given name is available/connecting */
  public getStatus(name: string): ConfigStatus {
    const config = getConfig(name);
    const folders = vscode.workspace.workspaceFolders || [];
    const isActive = this.getActiveFileSystems().find(fs => fs.config.name === name);
    const isConnected = folders.some(f => f.uri.scheme === 'ssh' && f.uri.authority === name);
    if (!config) return isActive ? ConfigStatus.Deleted : ConfigStatus.Error;
    if (isConnected) {
      if (isActive) return ConfigStatus.Active;
      if (this.creatingFileSystems[name]) return ConfigStatus.Connecting;
      return ConfigStatus.Error;
    }
    return ConfigStatus.Idle;
  }
  public async createFileSystem(name: string, config?: FileSystemConfig): Promise<SSHFileSystem> {
    const existing = this.fileSystems.find(fs => fs.authority === name);
    if (existing) return existing;
    let con: Connection | undefined;
    return this.creatingFileSystems[name] ||= catchingPromise<SSHFileSystem>(async (resolve, reject) => {
      config = config || getConfigs().find(c => c.name === name);
      if (!config) throw new Error(`Couldn't find a configuration with the name '${name}'`);
      const con = await this.connectionManager.createConnection(name, config);
      con.pendingUserCount++;
      config = con.actualConfig;
      const { getSFTP } = await import('./connect');
      const { SSHFileSystem } = await import('./sshFileSystem');
      // Query/calculate the root directory
      let root = config!.root || '/';
      if (root.startsWith('~')) {
        const home = await tryGetHome(con.client);
        if (!home) {
          await vscode.window.showErrorMessage(`Couldn't detect the home directory for '${name}'`, 'Okay');
          return reject();
        }
        root = root.replace(/^~/, home.replace(/\/$/, ''));
      }
      // Create the actual SFTP session (using the connection's actualConfig, otherwise it'll reprompt for passwords etc)
      const sftp = await getSFTP(con.client, con.actualConfig);
      const fs = new SSHFileSystem(name, sftp, root, config!);
      Logging.info(`Created SSHFileSystem for ${name}, reading root directory...`);
      // Sanity check that we can actually access the root directory (maybe it requires permissions we don't have)
      try {
        const rootUri = vscode.Uri.parse(`ssh://${name}/`);
        const stat = await fs.stat(rootUri);
        // tslint:disable-next-line:no-bitwise
        if (!(stat.type & vscode.FileType.Directory)) {
          throw vscode.FileSystemError.FileNotADirectory(rootUri);
        }
      } catch (e) {
        let message = `Couldn't read the root directory '${fs.root}' on the server for SSH FS '${name}'`;
        if (e instanceof vscode.FileSystemError) {
          message = `Path '${fs.root}' in SSH FS '${name}' is not a directory`;
        }
        Logging.error(e);
        await vscode.window.showErrorMessage(message, 'Okay');
        return reject();
      }
      con.filesystems.push(fs);
      this.fileSystems.push(fs);
      delete this.creatingFileSystems[name];
      vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      this.onDidChangeTreeDataEmitter.fire(null);
      con.client.once('close', hadError => hadError ? this.commandReconnect(name) : (!fs.closing && this.promptReconnect(name)));
      con.pendingUserCount--;
      return resolve(fs);
    }).catch((e) => {
      if (con) con.pendingUserCount--; // I highly doubt resolve(fs) will error
      this.onDidChangeTreeDataEmitter.fire(null);
      if (!e) {
        delete this.creatingFileSystems[name];
        this.commandDisconnect(name);
        throw e;
      }
      Logging.error(`Error while connecting to SSH FS ${name}:\n${e.message}`);
      Logging.error(e);
      vscode.window.showErrorMessage(`Error while connecting to SSH FS ${name}:\n${e.message}`, 'Retry', 'Configure', 'Ignore').then((chosen) => {
        delete this.creatingFileSystems[name];
        if (chosen === 'Retry') {
          this.createFileSystem(name).catch(() => { });
        } else if (chosen === 'Configure') {
          this.commandConfigure(name);
        } else {
          this.commandDisconnect(name);
        }
      });
      throw e;
    });
  }
  public getRemotePath(config: FileSystemConfig, relativePath: string) {
    if (relativePath.startsWith('/')) relativePath = relativePath.substr(1);
    if (!config.root) return '/' + relativePath;
    const result = path.posix.join(config.root, relativePath);
    if (result.startsWith('~')) return result; // Home directory, leave the ~/
    if (result.startsWith('/')) return result; // Already starts with /
    return '/' + result; // Add the / to make sure it isn't seen as a relative path
  }
  public async createTerminal(name: string, config?: FileSystemConfig, uri?: vscode.Uri): Promise<void> {
    const { createTerminal } = await import('./pseudoTerminal');
    // Create connection (early so we have .actualConfig.root)
    const con = await this.connectionManager.createConnection(name, config);
    // Calculate working directory if applicable
    let workingDirectory: string | undefined = uri && uri.path;
    if (workingDirectory) workingDirectory = this.getRemotePath(con.actualConfig, workingDirectory);
    // Create pseudo terminal
    con.pendingUserCount++;
    const pty = await createTerminal({ client: con.client, config: con.actualConfig, workingDirectory });
    pty.onDidClose(() => con.terminals = con.terminals.filter(t => t !== pty));
    con.terminals.push(pty);
    con.pendingUserCount--;
    // Create and show the graphical representation
    const terminal = vscode.window.createTerminal({ name, pty });
    terminal.show();
  }
  public getActiveFileSystems(): readonly SSHFileSystem[] {
    return this.fileSystems;
  }
  public getFs(uri: vscode.Uri): SSHFileSystem | null {
    const fs = this.fileSystems.find(f => f.authority === uri.authority);
    if (fs) return fs;
    return null;
  }
  public async promptReconnect(name: string) {
    const config = getConfig(name);
    console.log('config', name, config);
    if (!config) return;
    const choice = await vscode.window.showWarningMessage(`SSH FS ${config.label || config.name} disconnected`, 'Reconnect', 'Disconnect');
    if (choice === 'Reconnect') {
      this.commandReconnect(name);
    } else {
      this.commandDisconnect(name);
    }
  }
  /* TreeDataProvider */
  public getTreeItem(element: string | FileSystemConfig): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return createTreeItem(this, element);
  }
  public getChildren(element: string | FileSystemConfig = ''): vscode.ProviderResult<(string | FileSystemConfig)[]> {
    if (typeof element === 'object') return []; // FileSystemConfig, has no children
    const configs = this.fileSystems.map(fs => fs.config).map(c => c._calculated || c);
    configs.push(...getConfigs().filter(c => !configs.find(fs => c.name === fs.name)));
    const matching = configs.filter(({ group }) => (group || '') === element);
    matching.sort((a, b) => a.name > b.name ? 1 : -1);
    let groups = getGroups(configs, true);
    if (element) {
      groups = groups.filter(g => g.startsWith(element) && g[element.length] === '.' && !g.includes('.', element.length + 1));
    } else {
      groups = groups.filter(g => !g.includes('.'));
    }
    return [...matching, ...groups.sort()];
  }
  /* TaskProvider */
  public provideTasks(token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.Task[]> {
    return [];
  }
  public async resolveTask(task: vscode.Task, token?: vscode.CancellationToken | undefined): Promise<vscode.Task> {
    let { host, command, workingDirectory } = task.definition as unknown as SSHShellTaskOptions;
    if (!host) throw new Error('Missing field \'host\' for ssh-shell task');
    if (!command) throw new Error('Missing field \'command\' for ssh-shell task');
    const config = getConfig(host);
    if (!config) throw new Error(`No configuration with the name '${host}' found for ssh-shell task`);
    // Calculate working directory if applicable
    if (workingDirectory) workingDirectory = this.getRemotePath(config, workingDirectory);
    return new vscode.Task(
      task.definition,
      vscode.TaskScope.Workspace,
      `SSH Task for ${host}`,
      'ssh',
      new vscode.CustomExecution(async () => {
        const connection = await this.connectionManager.createConnection(host);
        connection.pendingUserCount++;
        const { createTerminal } = await import('./pseudoTerminal');
        const psy = await createTerminal({
          command, workingDirectory,
          client: connection.client,
          config: connection.actualConfig,
        });
        connection.pendingUserCount--;
        connection.terminals.push(psy);
        psy.onDidClose(() => connection.terminals = connection.terminals.filter(t => t !== psy));
        return psy;
      })
    )
  }
  /* Commands (stuff for e.g. context menu for ssh-configs tree) */
  public commandConnect(config: FileSystemConfig) {
    Logging.info(`Command received to connect ${config.name}`);
    const folders = vscode.workspace.workspaceFolders!;
    const folder = folders && folders.find(f => f.uri.scheme === 'ssh' && f.uri.authority === config.name);
    if (folder) return vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    vscode.workspace.updateWorkspaceFolders(folders ? folders.length : 0, 0, {
      uri: vscode.Uri.parse(`ssh://${config.name}/`),
      name: `SSH FS - ${config.label || config.name}`,
    });
  }
  public commandDisconnect(target: string | Connection) {
    Logging.info(`Command received to disconnect ${commandArgumentToName(target)}`);
    let cons: Connection[];
    if (typeof target === 'object' && 'client' in target) {
      cons = [target];
      target = target.actualConfig.name;
    } else {
      cons = this.connectionManager.getActiveConnections()
        .filter(con => con.actualConfig.name === target);
    }
    for (const con of cons) this.connectionManager.closeConnection(con);
    const folders = vscode.workspace.workspaceFolders!;
    let start: number = folders.length;
    let left: vscode.WorkspaceFolder[] = [];
    for (const folder of folders) {
      if (folder.uri.scheme === 'ssh' && folder.uri.authority === target) {
        start = Math.min(folder.index, start);
      } else if (folder.index > start) {
        left.push(folder);
    }
    };
    vscode.workspace.updateWorkspaceFolders(start, folders.length - start, ...left);
  }
  public async commandTerminal(target: FileSystemConfig | Connection, uri?: vscode.Uri) {
    Logging.info(`Command received to open a terminal for ${commandArgumentToName(target)}${uri ? ` in ${uri}` : ''}`);
    const config = 'client' in target ? target.actualConfig : target;
    // If no Uri is given, default to ssh://<target>/ which should respect config.root
    uri = uri || vscode.Uri.parse(`ssh://${config.name}/`, true);
    try {
      await this.createTerminal(config.label || config.name, target, uri);
    } catch (e) {
      const choice = await vscode.window.showErrorMessage<vscode.MessageItem>(
        `Couldn't start a terminal for ${config.name}: ${e.message || e}`,
        { title: 'Retry' }, { title: 'Ignore', isCloseAffordance: true });
      if (choice && choice.title === 'Retry') return this.commandTerminal(target, uri);
    }
  }
  public async commandConfigure(target: string | FileSystemConfig) {
    Logging.info(`Command received to configure ${typeof target === 'string' ? target : target.name}`);
    if (typeof target === 'object') {
      this.openSettings({ config: target, type: 'editconfig' });
      return;
    }
    target = target.toLowerCase();
    let configs = await loadConfigsRaw();
    configs = configs.filter(c => c.name === target);
    if (configs.length === 0) throw new Error('Unexpectedly found no matching configs?');
    const config = configs.length === 1 ? configs[0] : configs;
    this.openSettings({ config, type: 'editconfig' });
  }
  public async openSettings(navigation?: Navigation) {
    const { open, navigate } = await import('./settings');
    return navigation ? navigate(navigation) : open();
  }
}
