
import { readFile } from 'fs';
import { parse as parseJsonc, ParseError } from 'jsonc-parser';
import * as path from 'path';
import { ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';
import { createSocket, createSSH } from './connect';
import SSHFileSystem, { EMPTY_FILE_SYSTEM } from './sshFileSystem';
import { catchingPromise, toPromise } from './toPromise';

async function assertFs(man: Manager, uri: vscode.Uri) {
  const fs = await man.getFs(uri);
  if (fs) return fs;
  return man.createFileSystem(uri.authority);
  // throw new Error(`A SSH filesystem with the name '${uri.authority}' doesn't exists`);
}

export interface ProxyConfig {
  type: 'socks4' | 'socks5';
  host: string;
  port: number;
}

export interface FileSystemConfig extends ConnectConfig {
  name: string;
  label?: string;
  root?: string;
  putty?: string | boolean;
  proxy?: ProxyConfig;
  privateKeyPath?: string;
}

export enum ConfigStatus {
  Idle = 'Idle',
  Active = 'Active',
  Deleted = 'Deleted',
  Connecting = 'Connecting',
  Error = 'Error',
}

function createTreeItem(manager: Manager, name: string): vscode.TreeItem {
  const config = manager.getConfig(name);
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

function createConfigFs(manager: Manager): SSHFileSystem {
  return {
    ...EMPTY_FILE_SYSTEM,
    authority: '<config>',
    stat: (uri: vscode.Uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 } as vscode.FileStat),
    readFile: async (uri: vscode.Uri) => {
      const name = uri.path.substring(1, uri.path.length - 12);
      let config = manager.getConfig(name);
      let activeButDeleted = false;
      if (!config) {
        config = config || manager.getActive().find(c => c.name === name);
        activeButDeleted = true;
      }
      let str;
      if (config) {
        str = JSON.stringify({ ...config, name: undefined }, undefined, 4);
        let prefix = `// If you haven't already, associate .jsonc files with "JSON with Comments (jsonc)\n`;
        if (activeButDeleted) prefix += '// This configuration is deleted, but still active!\n';
        str = `${prefix}${str}`;
      } else {
        str = await toPromise<string>(cb => readFile(path.resolve(__dirname, '../resources/defaultConfig.jsonc'), 'utf-8', cb));
      }
      return new Uint8Array(new Buffer(str));
    },
    writeFile: async (uri: vscode.Uri, content: Uint8Array) => {
      const name = uri.path.substring(1, uri.path.length - 12);
      const errors: ParseError[] = [];
      const config = parseJsonc(new Buffer(content).toString(), errors);
      if (!config || errors.length) {
        vscode.window.showErrorMessage(`Couldn't parse this config as JSON`);
        return;
      }
      config.name = name;
      const loc = await manager.updateConfig(name, config);
      let dialog: Thenable<string | undefined>;
      if (loc === vscode.ConfigurationTarget.Global) {
        dialog = vscode.window.showInformationMessage(`Config for '${name}' saved globally`, 'Connect', 'Okay');
      } else if (loc === vscode.ConfigurationTarget.Workspace) {
        dialog = vscode.window.showInformationMessage(`Config for '${name}' saved for this workspace`, 'Connect', 'Okay');
      } else if (loc === vscode.ConfigurationTarget.WorkspaceFolder) {
        dialog = vscode.window.showInformationMessage(`Config for '${name}' saved for the current workspace folder`, 'Connect', 'Okay');
      } else {
        throw new Error(`This isn't supposed to happen! Config location was '${loc}' somehow`);
      }
      dialog.then(response => response === 'Connect' && manager.commandReconnect(name));
    },
  } as any;
}

export class Manager implements vscode.FileSystemProvider, vscode.TreeDataProvider<string> {
  public onDidChangeTreeData: vscode.Event<string>;
  public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  protected fileSystems: SSHFileSystem[] = [];
  protected creatingFileSystems: { [name: string]: Promise<SSHFileSystem> } = {};
  protected configFileSystem = createConfigFs(this);
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<string>();
  protected skippedConfigNames: string[] = [];
  // private memento: vscode.Memento = this.context.globalState;
  constructor(public readonly context: vscode.ExtensionContext) {
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    const folderAdded = async (folder) => {
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      // if (!e.affectsConfiguration('sshfs.configs')) return;
      this.onDidChangeTreeDataEmitter.fire();
      // TODO: Offer to reconnect everything
    });
    this.loadConfigs();
  }
  public invalidConfigName(name: string) {
    if (!name) return 'Missing a name for this SSH FS';
    if (name.match(/^[\w_\\\/\.@\-+]+$/)) return null;
    return `A SSH FS name can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@`;
  }
  public getConfig(name: string) {
    if (name === '<config>') return null;
    return this.loadConfigs().find(c => c.name === name);
    // return this.memento.get<FileSystemConfig>(`fs.config.${name}`);
  }
  public getStatus(name: string): ConfigStatus {
    const config = this.getConfig(name);
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
  public async registerFileSystem(name: string, config?: FileSystemConfig) {
    if (name === '<config>') return;
    this.updateConfig(name, config);
  }
  public async createFileSystem(name: string, config?: FileSystemConfig): Promise<SSHFileSystem> {
    if (name === '<config>') return this.configFileSystem;
    const existing = this.fileSystems.find(fs => fs.authority === name);
    if (existing) return existing;
    let promise = this.creatingFileSystems[name];
    if (promise) return promise;
    // config = config || this.memento.get(`fs.config.${name}`);
    config = config || this.loadConfigs().find(c => c.name === name);
    promise = catchingPromise<SSHFileSystem>(async (resolve, reject) => {
      if (!config) {
        throw new Error(`A SSH filesystem with the name '${name}' doesn't exist`);
      }
      this.registerFileSystem(name, { ...config });
      const sock = await createSocket(config);
      if (sock == null) return reject(null);
      const client = await createSSH(config, sock);
      if (!client) return reject(null);
      client.sftp((err, sftp) => {
        if (err) {
          client.end();
          return reject(err);
        }
        sftp.once('end', () => client.end());
        const fs = new SSHFileSystem(name, sftp, config!.root || '/', config!);
        this.fileSystems.push(fs);
        delete this.creatingFileSystems[name];
        vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        this.onDidChangeTreeDataEmitter.fire();
        client.once('close', hadError => hadError ? this.commandReconnect(name) : (!fs.closing && this.promptReconnect(name)));
        return resolve(fs);
      });
    }).catch((e) => {
      this.onDidChangeTreeDataEmitter.fire();
      if (!e) {
        delete this.creatingFileSystems[name];
        this.commandDisconnect(name);
        throw e;
      }
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
    const config = this.getConfig(name);
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
    return (await assertFs(this, uri)).readFile(uri);
  }
  public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
    return (await assertFs(this, uri)).writeFile(uri, content, options);
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
    return (await assertFs(this, uri)).delete(uri, options);
  }
  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
    const fs = await assertFs(this, oldUri);
    if (fs !== (await assertFs(this, newUri))) throw new Error(`Can't copy between different SSH filesystems`);
    return fs.rename(oldUri, newUri, options);
  }
  /* TreeDataProvider */
  public getTreeItem(element: string): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return createTreeItem(this, element);
  }
  public getChildren(element?: string | undefined): vscode.ProviderResult<string[]> {
    const configs = this.loadConfigs().map(c => c.name);
    this.fileSystems.forEach(fs => configs.indexOf(fs.authority) === -1 && configs.push(fs.authority));
    const folders = vscode.workspace.workspaceFolders || [];
    folders.filter(f => f.uri.scheme === 'ssh').forEach(f => configs.indexOf(f.uri.authority) === -1 && configs.push(f.uri.authority));
    return configs;
  }
  /* Commands (stuff for e.g. context menu for ssh-configs tree) */
  public commandDisconnect(name: string) {
    const fs = this.fileSystems.find(f => f.authority === name);
    if (fs) {
      fs.disconnect();
      this.fileSystems.splice(this.fileSystems.indexOf(fs), 1);
    }
    const folders = vscode.workspace.workspaceFolders!;
    const index = folders.findIndex(f => f.uri.scheme === 'ssh' && f.uri.authority === name);
    if (index !== -1) vscode.workspace.updateWorkspaceFolders(index, 1);
    this.onDidChangeTreeDataEmitter.fire();
  }
  public commandReconnect(name: string) {
    const fs = this.fileSystems.find(f => f.authority === name);
    if (fs) {
      fs.disconnect();
      this.fileSystems.splice(this.fileSystems.indexOf(fs), 1);
    }
    this.commandConnect(name);
  }
  public commandConnect(name: string) {
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
    vscode.window.showTextDocument(vscode.Uri.parse(`ssh://<config>/${name}.sshfs.jsonc`), { preview: false });
  }
  public commandDelete(name: string) {
    this.commandDisconnect(name);
    this.updateConfig(name);
  }
  /* Configuration discovery */
  public loadConfigs() {
    const config = vscode.workspace.getConfiguration('sshfs');
    if (!config) return [];
    const inspect = config.inspect<FileSystemConfig[]>('configs')!;
    let configs: FileSystemConfig[] = [
      ...(inspect.workspaceFolderValue || []),
      ...(inspect.workspaceValue || []),
      ...(inspect.globalValue || []),
    ];
    configs.forEach(c => c.name = c.name.toLowerCase());
    configs = configs.filter((c, i) => configs.findIndex(c2 => c2.name === c.name) === i);
    for (const index in configs) {
      if (!configs[index].name) {
        vscode.window.showErrorMessage(`Skipped an invalid SSH FS config (missing a name field)`);
      } else if (this.invalidConfigName(configs[index].name)) {
        const conf = configs[index];
        if (this.skippedConfigNames.indexOf(conf.name) !== -1) continue;
        vscode.window.showErrorMessage(`Invalid SSH FS config name: ${conf.name}`, 'Rename', 'Delete', 'Skip').then(async (answer) => {
          if (answer === 'Rename') {
            const name = await vscode.window.showInputBox({ prompt: `New name for: ${conf.name}`, validateInput: this.invalidConfigName, placeHolder: 'New name' });
            if (name) {
              conf.name = name;
              return this.updateConfig(conf.name, conf);
            }
            vscode.window.showWarningMessage(`Skipped SSH FS config '${conf.name}'`);
          } else if (answer === 'Delete') {
            return this.updateConfig(conf.name);
          }
          this.skippedConfigNames.push(conf.name);
        });
      }
    }
    return configs.filter(c => !this.invalidConfigName(c.name));
  }
  public getConfigLocation(name: string) {
    const conf = vscode.workspace.getConfiguration('sshfs');
    const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
    const contains = (v?: FileSystemConfig[]) => v && v.find(c => c.name === name);
    if (contains(inspect.workspaceFolderValue)) {
      return vscode.ConfigurationTarget.WorkspaceFolder;
    } else if (contains(inspect.workspaceValue)) {
      return vscode.ConfigurationTarget.Workspace;
    } else { // if (contains(inspect.globalValue)) {
      return vscode.ConfigurationTarget.Global;
    }
  }
  public async updateConfig(name: string, config?: FileSystemConfig) {
    const conf = vscode.workspace.getConfiguration('sshfs');
    const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
    // const contains = (v?: FileSystemConfig[]) => v && v.find(c => c.name === name);
    const patch = (v: FileSystemConfig[]) => {
      const con = v.findIndex(c => c.name === name);
      if (!config) return v.filter(c => c.name.toLowerCase() !== name);
      v[con === -1 ? v.length : con] = config;
      return v;
    };
    const loc = this.getConfigLocation(name);
    const array = [[], inspect.globalValue, inspect.workspaceValue, inspect.workspaceFolderValue][loc];
    await conf.update('configs', patch(array || []), loc || vscode.ConfigurationTarget.Global);
    this.onDidChangeTreeDataEmitter.fire();
    return loc;
  }
}

export default Manager;
