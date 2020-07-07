
import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { configMatches, getConfig, getConfigs, loadConfigs, loadConfigsRaw, UPDATE_LISTENERS } from './config';
import { FileSystemConfig, getGroups } from './fileSystemConfig';
import { Logging } from './logging';
import { SSHPseudoTerminal } from './pseudoTerminal';
import { catchingPromise, toPromise } from './toPromise';
import { Navigation } from './webviewMessages';

type SSHFileSystem = import('./sshFileSystem').SSHFileSystem;

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

interface Connection {
  config: FileSystemConfig;
  actualConfig: FileSystemConfig;
  client: Client;
  terminals: SSHPseudoTerminal[];
  filesystems: SSHFileSystem[];
  pendingUserCount: number;
}

export class Manager implements vscode.TreeDataProvider<string | FileSystemConfig> {
  public onDidChangeTreeData: vscode.Event<string | null>;
  protected connections: Connection[] = [];
  protected pendingConnections: { [name: string]: Promise<Connection> } = {};
  protected fileSystems: SSHFileSystem[] = [];
  protected creatingFileSystems: { [name: string]: Promise<SSHFileSystem> } = {};
  protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<string | null>();
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
  public getActiveConnection(name: string, config?: FileSystemConfig): Connection | undefined {
    let con = config && this.connections.find(con => configMatches(con.config, config));
    // If a config was given and we have a connection with the same-ish config, return it
    if (con) return con;
    // Otherwise if no config was given, just any config with the same name is fine
    return config ? undefined : this.connections.find(con => con.config.name === name);
  }
  public async createConnection(name: string, config?: FileSystemConfig): Promise<Connection> {
    const logging = Logging.here(`createConnection(${name},${config && 'config'})`);
    let con = this.getActiveConnection(name, config);
    if (con) return con;
    let promise = this.pendingConnections[name];
    if (promise) return promise;
    return this.pendingConnections[name] = (async (): Promise<Connection> => {
      logging.info(`Creating a new connection for '${name}'`);
      const { createSSH, calculateActualConfig } = await import('./connect');
      config = config || (await loadConfigs()).find(c => c.name === name);
      if (!config) throw new Error(`No configuration with name '${name}' found`);
      const actualConfig = await calculateActualConfig(config);
      const client = await createSSH(actualConfig);
      if (!client) throw new Error(`Could not create SSH session for '${name}'`);
      con = {
        config, client, actualConfig,
        terminals: [],
        filesystems: [],
        pendingUserCount: 0,
      };
      this.connections.push(con);
      let timeoutCounter = 0;
      // Start a timer that'll automatically close the connection once it hasn't been used in a while (about 5s)
      const timer = setInterval(() => {
        timeoutCounter = timeoutCounter ? timeoutCounter - 1 : 0;
        // If something's initiating on the connection, keep it alive
        // (the !con is just for intellisense purposes, should never be undefined)
        if (!con || con.pendingUserCount) return;
        con.filesystems = con.filesystems.filter(fs => !fs.closed && !fs.closing);
        if (con.filesystems.length) return; // Still got active filesystems on this connection
        // When the manager creates a terminal, it also links up an event to remove it from .terminals when it closes
        if (con.terminals.length) return; // Still got active terminals on this connection
        // Next iteration, if the connection is still unused, close it
        // First iteration here = 2
        // Next iteration = 1
        //   If nothing of the "active" if-statements returned, it'll be 1 here
        // After that = 0
        if (timeoutCounter !== 1) {
          timeoutCounter = 2;
          return;
        }
        // timeoutCounter == 1, so it's been inactive for at least 5 seconds, close it!
        logging.info(`Closing connection to '${name}' due to no active filesystems/terminals`);
        clearInterval(timer);
        this.connections = this.connections.filter(c => c !== con);
        con.client.destroy();
      }, 5e3);
      return con;
    })().finally(() => delete this.pendingConnections[name]);
  }
  public async createFileSystem(name: string, config?: FileSystemConfig): Promise<SSHFileSystem> {
    const existing = this.fileSystems.find(fs => fs.authority === name);
    if (existing) return existing;
    let promise = this.creatingFileSystems[name];
    if (promise) return promise;
    config = config || (await getConfigs()).find(c => c.name === name);
    if (!config) throw new Error(`Couldn't find a configuration with the name '${name}'`);
    const con = await this.createConnection(name, config);
    con.pendingUserCount++;
    config = con.actualConfig;
    promise = catchingPromise<SSHFileSystem>(async (resolve, reject) => {
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
      con.pendingUserCount--; // I highly doubt resolve(fs) will error
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
    return this.creatingFileSystems[name] = promise;
  }
  public async createTerminal(name: string, config?: FileSystemConfig): Promise<void> {
    const { createTerminal } = await import('./pseudoTerminal');
    const con = await this.createConnection(name, config);
    con.pendingUserCount++;
    const pty = await createTerminal(con.client, con.actualConfig);
    pty.onDidClose(() => con.terminals = con.terminals.filter(t => t !== pty));
    con.terminals.push(pty);
    con.pendingUserCount--;
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
    const configs = this.fileSystems.map(fs => fs.config);
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
  /* Commands (stuff for e.g. context menu for ssh-configs tree) */
  public commandDisconnect(target: string | FileSystemConfig) {
    if (typeof target === 'object') target = target.name;
    Logging.info(`Command received to disconnect ${target}`);
    const fs = this.fileSystems.find(f => f.authority === target);
    if (fs) {
      fs.disconnect();
      this.fileSystems.splice(this.fileSystems.indexOf(fs), 1);
    }
    delete this.creatingFileSystems[target];
    const folders = vscode.workspace.workspaceFolders!;
    const index = folders.findIndex(f => f.uri.scheme === 'ssh' && f.uri.authority === target);
    if (index !== -1) vscode.workspace.updateWorkspaceFolders(index, 1);
    this.onDidChangeTreeDataEmitter.fire(null);
  }
  public commandReconnect(target: string | FileSystemConfig) {
    if (typeof target === 'object') target = target.name;
    Logging.info(`Command received to reconnect ${target}`);
    const fs = this.fileSystems.find(f => f.authority === target);
    if (fs) {
      fs.disconnect();
      this.fileSystems.splice(this.fileSystems.indexOf(fs), 1);
    }
    delete this.creatingFileSystems[target];
    // Even if we got an actual config object, we're passing on the name here
    // This allows it to pick up config changes (which is why we usually reconnect)
    this.commandConnect(target);
  }
  public commandConnect(target: string | FileSystemConfig) {
    const config = typeof target === 'object' ? target : undefined;
    if (typeof target === 'object') target = target.name;
    Logging.info(`Command received to connect ${target}`);
    const existing = this.fileSystems.find(fs => fs.config.name === target);
    if (existing) return vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    const folders = vscode.workspace.workspaceFolders!;
    const folder = folders && folders.find(f => f.uri.scheme === 'ssh' && f.uri.authority === target);
    if (folder) {
      this.onDidChangeTreeDataEmitter.fire(null);
      return this.createFileSystem(target, config);
    }
    vscode.workspace.updateWorkspaceFolders(folders ? folders.length : 0, 0, { uri: vscode.Uri.parse(`ssh://${target}/`), name: `SSH FS - ${target}` });
    this.onDidChangeTreeDataEmitter.fire(null);
  }
  public async commandTerminal(target: string | FileSystemConfig) {
    if (typeof target === 'string') {
      await this.createTerminal(target);
    } else {
      await this.createTerminal(target.label || target.name, target);
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
