
import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { getConfig, getConfigs, loadConfigs, loadConfigsRaw, UPDATE_LISTENERS } from './config';
import { FileSystemConfig } from './fileSystemConfig';
import * as Logging from './logging';
import SSHFileSystem from './sshFileSystem';
import { catchingPromise, toPromise } from './toPromise';
import { Navigation } from './webviewMessages';

async function assertFs(man: Manager, uri: vscode.Uri) {
  const fs = await man.getFs(uri);
  if (fs) return fs;
  return man.createFileSystem(uri.authority);
}

export enum ConfigStatus {
  Idle = 'Idle',
  Active = 'Active',
  Deleted = 'Deleted',
  Connecting = 'Connecting',
  Error = 'Error',
}

function createTreeItem(manager: Manager, name: string): vscode.TreeItem {
  const config = getConfig(name);
  const folders = vscode.workspace.workspaceFolders || [];
  const isConnected = folders.some(f => f.uri.scheme === 'ssh' && f.uri.authority === name);
  const status = manager.getStatus(name);
  return {
    label: config && config.label || name,
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

export class Manager implements vscode.FileSystemProvider, vscode.TreeDataProvider<string> {
  public onDidChangeTreeData: vscode.Event<string>;
  public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  protected fileSystems: SSHFileSystem[] = [];
  protected creatingFileSystems: { [name: string]: Promise<SSHFileSystem> } = {};
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<string>();
  constructor(public readonly context: vscode.ExtensionContext) {
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    const folderAdded = async (folder: vscode.WorkspaceFolder) => {
      if (folder.uri.scheme !== 'ssh') return;
      this.createFileSystem(folder.uri.authority);
    };
    const folders = vscode.workspace.workspaceFolders || [];
    folders.forEach(folderAdded);
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      e.added.forEach(folderAdded);
      e.removed.forEach(async (folder) => {
        if (folder.uri.scheme !== 'ssh') return;
        this.commandDisconnect(folder.uri.authority);
      });
      this.onDidChangeTreeDataEmitter.fire();
    });
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      // if (!e.affectsConfiguration('sshfs.configs')) return;
      return loadConfigs();
    });
    UPDATE_LISTENERS.push(() => this.fireConfigChanged());
    loadConfigs();
  }
  public fireConfigChanged(): void {
    this.onDidChangeTreeDataEmitter.fire();
    // TODO: Offer to reconnect everything
  }
  public getStatus(name: string): ConfigStatus {
    const config = getConfig(name);
    const folders = vscode.workspace.workspaceFolders || [];
    const isActive = this.getActive().find(c => c.name === name);
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
    let promise = this.creatingFileSystems[name];
    if (promise) return promise;
    config = config || (await loadConfigs()).find(c => c.name === name);
    promise = catchingPromise<SSHFileSystem>(async (resolve, reject) => {
      const { createSSH, getSFTP, calculateActualConfig } = await import('./connect');
      config = config && await calculateActualConfig(config) || undefined;
      if (!config) {
        throw new Error(`A SSH filesystem with the name '${name}' doesn't exist`);
      }
      const client = await createSSH(config);
      if (!client) return reject(null);
      let root = config!.root || '/';
      if (root.startsWith('~')) {
        const home = await tryGetHome(client);
        if (!home) {
          await vscode.window.showErrorMessage(`Couldn't detect the home directory for '${name}'`, 'Okay');
          return reject();
        }
        root = root.replace(/^~/, home.replace(/\/$/, ''));
      }
      const sftp = await getSFTP(client, config);
      const fs = new SSHFileSystem(name, sftp, root, config!);
      Logging.info(`Created SSHFileSystem for ${name}, reading root directory...`);
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
        Logging.error(message);
        await vscode.window.showErrorMessage(message, 'Okay');
        return reject();
      }
      this.fileSystems.push(fs);
      delete this.creatingFileSystems[name];
      vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      this.onDidChangeTreeDataEmitter.fire();
      client.once('close', hadError => hadError ? this.commandReconnect(name) : (!fs.closing && this.promptReconnect(name)));
      return resolve(fs);
    }).catch((e) => {
      this.onDidChangeTreeDataEmitter.fire();
      if (!e) {
        delete this.creatingFileSystems[name];
        this.commandDisconnect(name);
        throw e;
      }
      Logging.error(`Error while connecting to SSH FS ${name}:\n${e.message}`);
      vscode.window.showErrorMessage(`Error while connecting to SSH FS ${name}:\n${e.message}`, 'Retry', 'Configure', 'Ignore').then((chosen) => {
        delete this.creatingFileSystems[name];
        if (chosen === 'Retry') {
          this.createFileSystem(name).catch(console.error);
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
  public getActive() {
    return this.fileSystems.map(fs => fs.config);
  }
  public async getFs(uri: vscode.Uri) {
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
  /* FileSystemProvider */
  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // TODO: Store watched files/directories in an array and periodically check if they're modified
    /*let disp = () => {};
    assertFs(this, uri).then((fs) => {
      disp = fs.watch(uri, options).dispose.bind(fs);
    }).catch(console.error);
    return new vscode.Disposable(() => disp());*/
    return new vscode.Disposable(() => { });
  }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return (await assertFs(this, uri)).stat(uri);
  }
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return (await assertFs(this, uri)).readDirectory(uri);
  }
  public async createDirectory(uri: vscode.Uri): Promise<void> {
    return (await assertFs(this, uri)).createDirectory(uri);
  }
  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    Logging.debug(`Reading ${uri}`);
    return (await assertFs(this, uri)).readFile(uri);
  }
  public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
    Logging.debug(`Writing ${content.length} bytes to ${uri}`);
    return (await assertFs(this, uri)).writeFile(uri, content, options);
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
    Logging.debug(`Deleting ${uri}`);
    return (await assertFs(this, uri)).delete(uri, options);
  }
  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
    Logging.debug(`Renaming ${oldUri} to ${newUri}`);
    const fs = await assertFs(this, oldUri);
    if (fs !== (await assertFs(this, newUri))) throw new Error(`Can't rename between different SSH filesystems`);
    return fs.rename(oldUri, newUri, options);
  }
  /* TreeDataProvider */
  public getTreeItem(element: string): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return createTreeItem(this, element);
  }
  public getChildren(element?: string | undefined): vscode.ProviderResult<string[]> {
    const configs = getConfigs().map(c => c.name);
    this.fileSystems.forEach(fs => configs.indexOf(fs.authority) === -1 && configs.push(fs.authority));
    const folders = vscode.workspace.workspaceFolders || [];
    folders.filter(f => f.uri.scheme === 'ssh').forEach(f => configs.indexOf(f.uri.authority) === -1 && configs.push(f.uri.authority));
    return configs.filter((c, i) => configs.indexOf(c) === i);
  }
  /* Commands (stuff for e.g. context menu for ssh-configs tree) */
  public commandDisconnect(name: string) {
    Logging.info(`Command received to disconnect ${name}`);
    const fs = this.fileSystems.find(f => f.authority === name);
    if (fs) {
      fs.disconnect();
      this.fileSystems.splice(this.fileSystems.indexOf(fs), 1);
    }
    delete this.creatingFileSystems[name];
    const folders = vscode.workspace.workspaceFolders!;
    const index = folders.findIndex(f => f.uri.scheme === 'ssh' && f.uri.authority === name);
    if (index !== -1) vscode.workspace.updateWorkspaceFolders(index, 1);
    this.onDidChangeTreeDataEmitter.fire();
  }
  public commandReconnect(name: string) {
    Logging.info(`Command received to reconnect ${name}`);
    const fs = this.fileSystems.find(f => f.authority === name);
    if (fs) {
      fs.disconnect();
      this.fileSystems.splice(this.fileSystems.indexOf(fs), 1);
    }
    delete this.creatingFileSystems[name];
    this.commandConnect(name);
  }
  public commandConnect(name: string) {
    Logging.info(`Command received to connect ${name}`);
    if (this.getActive().find(fs => fs.name === name)) return vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    const folders = vscode.workspace.workspaceFolders!;
    const folder = folders && folders.find(f => f.uri.scheme === 'ssh' && f.uri.authority === name);
    if (folder) {
      this.onDidChangeTreeDataEmitter.fire();
      return this.createFileSystem(name);
    }
    vscode.workspace.updateWorkspaceFolders(folders ? folders.length : 0, 0, { uri: vscode.Uri.parse(`ssh://${name}/`), name: `SSH FS - ${name}` });
    this.onDidChangeTreeDataEmitter.fire();
  }
  public async commandConfigure(name: string) {
    Logging.info(`Command received to configure ${name}`);
    name = name.toLowerCase();
    let configs = await loadConfigsRaw();
    configs = configs.filter(c => c.name === name);
    if (configs.length === 0) throw new Error('Unexpectedly found no matching configs?');
    const config = configs.length === 1 ? configs[0] : configs;
    this.openSettings({ config, type: 'editconfig' });
  }
  public async openSettings(navigation?: Navigation) {
    const { open, navigate } = await import('./settings');
    return navigation ? navigate(navigation) : open();
  }
}

export default Manager;
