
import { readFile } from 'fs';
import { Client, ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';

import { getSession as getPuttySession, PuttySession } from './putty';
import SSHFileSystem, { EMPTY_FILE_SYSTEM } from './sshFileSystem';
import { toPromise } from './toPromise';

async function assertFs(man: Manager, uri: vscode.Uri) {
  const fs = await man.getFs(uri);
  if (fs) return fs;
  return man.createFileSystem(uri.authority);
  // throw new Error(`A SSH filesystem with the name '${uri.authority}' doesn't exists`);
}

export interface FileSystemConfig extends ConnectConfig {
  name: string;
  root?: string;
  putty?: string | boolean;
}

function createTreeItem(manager: Manager, name: string): vscode.TreeItem {
  const config = manager.getConfig(name);
  const folders = vscode.workspace.workspaceFolders || [];
  const active = folders.some(f => f.uri.scheme === 'ssh' && f.uri.authority === name);
  return {
    label: name,
    contextValue: active ? 'active' : 'inactive',
    tooltip: config ? (active ? 'Active' : 'Inactive') : 'Active but deleted',
  };
}

const defaultConfig: FileSystemConfig = ({
  name: undefined!, root: '/', host: 'localhost', port: 22,
  username: 'root', password: 'CorrectHorseBatteryStaple',
});
function createConfigFs(manager: Manager): SSHFileSystem {
  return {
    ...EMPTY_FILE_SYSTEM,
    authority: '<config>',
    stat: (uri: vscode.Uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 } as vscode.FileStat),
    readFile: (uri: vscode.Uri) => {
      const name = uri.path.substring(1, uri.path.length - 11);
      let config = manager.getConfig(name) || defaultConfig;
      config = { ...config, name: undefined! };
      return new Uint8Array(new Buffer(JSON.stringify(config, undefined, 4)));
    },
    writeFile: (uri: vscode.Uri, content: Uint8Array) => {
      const name = uri.path.substring(1, uri.path.length - 11);
      try {
        const config = JSON.parse(new Buffer(content).toString());
        config.name = name;
        const loc = manager.updateConfig(name, config);
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
        dialog.then(o => o === 'Connect' && manager.commandReconnect(name));
      } catch (e) {
        vscode.window.showErrorMessage(`Couldn't parse this config as JSON`);
      }
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
  constructor(protected readonly context: vscode.ExtensionContext) {
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
    });
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('sshfs.configs')) return;
      this.onDidChangeTreeDataEmitter.fire();
      // TODO: Offer to reconnect everything
    });
    this.loadConfigs();
  }
  public invalidConfigName(name: string) {
    if (!name) return 'Missing a name for this SSH FS';
    if (name.match(/^[\w_\\\/\.@\-+]+$/)) return null;
    return `A SSH FS name can only exists of alphanumeric characters, slashes and any of these: _.+-@`;
  }
  public getConfig(name: string) {
    if (name === '<config>') return null;
    return this.loadConfigs().find(c => c.name === name);
    // return this.memento.get<FileSystemConfig>(`fs.config.${name}`);
  }
  public async registerFileSystem(name: string, config?: FileSystemConfig) {
    if (name === '<config>') return;
    // this.memento.update(`fs.config.${name}`, config);
    this.updateConfig(name, config);
    // const configs: string[] = this.memento.get('fs.configs',[]);
    // if (configs.indexOf(name) === -1) configs.push(name);
    // this.memento.update('fs.configs', configs);
    this.onDidChangeTreeDataEmitter.fire();
  }
  public async createFileSystem(name: string, config?: FileSystemConfig): Promise<SSHFileSystem> {
    if (name === '<config>') return this.configFileSystem;
    const existing = this.fileSystems.find(fs => fs.authority === name);
    if (existing) return existing;
    let promise = this.creatingFileSystems[name];
    if (promise) return promise;
    // config = config || this.memento.get(`fs.config.${name}`);
    config = config || (await this.loadConfigs()).find(c => c.name === name);
    promise = new Promise<SSHFileSystem>(async (resolve, reject) => {
      if (!config) {
        throw new Error(`A SSH filesystem with the name '${name}' doesn't exist`);
      }
      this.registerFileSystem(name, config);
      if (config.putty) {
        let nameOnly = true;
        if (config.putty === true) {
          if (!config.host) return reject(new Error(`'putty' was true but 'host' is empty/missing`));
          config.putty = config.host;
          nameOnly = false;
        }
        const session = await getPuttySession(config.putty, config.host, config.username, nameOnly);
        if (!session) return reject(new Error(`Couldn't find the requested PuTTY session`));
        if (session.protocol !== 'ssh') return reject(new Error(`The requested PuTTY session isn't a SSH session`));
        config.username = session.username;
        config.host = session.hostname;
        config.port = session.portnumber;
        config.agent = session.tryagent ? 'pageant' : undefined;
        if (session.usernamefromenvironment) {
          session.username = process.env.USERNAME;
          if (!session.username) return reject(new Error(`No username specified in the session (nor is using the system username enabled)`));
        }
        if (!config.agent && session.publickeyfile) {
          try {
            const key = await toPromise<Buffer>(cb => readFile(session.publickeyfile, cb));
            config.privateKey = key;
          } catch (e) {
            return reject(new Error(`Error while reading the keyfile at:\n${session.publickeyfile}`));
          }
        }
      }
      if ((config.password as any) === true) {
        config.passphrase = await vscode.window.showInputBox({
          password: true,
          ignoreFocusOut: true,
          placeHolder: 'Password',
          prompt: 'Password for the provided username',
        });
      }
      if ((config.passphrase as any) === true) {
        if (config.privateKey) {
          config.passphrase = await vscode.window.showInputBox({
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'Passphrase',
            prompt: 'Passphrase for the provided public/private key',
          });
        } else {
          const answer = await vscode.window.showWarningMessage(`The field 'passphrase' was set to true, but no key was provided`, 'Configure', 'Ignore');
          if (answer === 'Configure') {
            this.commandConfigure(name);
            return reject(null);
          }
        }
      }
      const client = new Client();
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            return reject(err);
          }
          sftp.on('end', () => client.end());
          const fs = new SSHFileSystem(name, sftp, config!.root || '/');
          this.fileSystems.push(fs);
          delete this.creatingFileSystems[name];
          vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
          return resolve(fs);
        });
      });
      client.on('timeout', () => reject(new Error(`Socket timed out while connecting SSH FS '${name}'`)));
      client.on('close', hadError => hadError && this.commandReconnect(name));
      client.on('error', (error) => {
        if (error.description) {
          error.message = `${error.description}\n${error.message}`;
        }
        reject(error);
      });
      try {
        client.connect(Object.assign(config, { tryKeyboard: false }));
      } catch (e) {
        reject(e);
      }
    }).catch((e) => {
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
    return this.fileSystems.map(fs => fs.authority);
  }
  public async getFs(uri: vscode.Uri) {
    const fs = this.fileSystems.find(f => f.authority === uri.authority);
    if (fs) return fs;
    return null;
  }
  /* FileSystemProvider */
  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    /*let disp = () => {};
    assertFs(this, uri).then((fs) => {
      disp = fs.watch(uri, options).dispose.bind(fs);
    }).catch(console.error);
    return new vscode.Disposable(() => disp());*/
    return new vscode.Disposable(() => {});
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
    if (this.getActive().indexOf(name) !== -1) return vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
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
    vscode.window.showTextDocument(vscode.Uri.parse(`ssh://<config>/${name}.sshfs.json`), { preview: false });
  }
  public commandConfigDelete(name: string) {
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
  public updateConfig(name: string, config?: FileSystemConfig) {
    const conf = vscode.workspace.getConfiguration('sshfs');
    const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
    // const contains = (v?: FileSystemConfig[]) => v && v.find(c => c.name === name);
    const patch = (v: FileSystemConfig[]) => {
      const con = v.findIndex(c => c.name === name);
      if (!config) return v.filter(c => c.name !== name);
      v[con === -1 ? v.length : con] = config;
      return v;
    };
    const loc = this.getConfigLocation(name);
    const array = [[], inspect.globalValue, inspect.workspaceValue, inspect.workspaceFolderValue][loc];
    conf.update('configs', patch(array || []), loc || vscode.ConfigurationTarget.Global);
    this.onDidChangeTreeDataEmitter.fire();
    return loc;
  }
}

export default Manager;
