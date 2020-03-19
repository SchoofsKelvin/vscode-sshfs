
import { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { getConfig, getConfigs, loadConfigs, loadConfigsRaw, UPDATE_LISTENERS } from './config';
import { FileSystemConfig, getGroups } from './fileSystemConfig';
import * as Logging from './logging';
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

export class Manager implements vscode.TreeDataProvider<string | FileSystemConfig> {
  public onDidChangeTreeData: vscode.Event<string>;
  protected fileSystems: SSHFileSystem[] = [];
  protected creatingFileSystems: { [name: string]: Promise<SSHFileSystem> } = {};
  protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<string>();
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
      this.onDidChangeTreeDataEmitter.fire();
    });
    UPDATE_LISTENERS.push(() => this.fireConfigChanged());
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
    promise = catchingPromise<SSHFileSystem>(async (resolve, reject) => {
      const { createSSH, getSFTP, calculateActualConfig } = await import('./connect');
      // tslint:disable-next-line:no-shadowed-variable (dynamic import for source splitting)
      const { SSHFileSystem } = await import('./sshFileSystem');
      config = config || (await loadConfigs()).find(c => c.name === name);
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
      
      vscode.debug.registerDebugConfigurationProvider("*", {
        resolveDebugConfiguration(folder: vscode.WorkspaceFolder, debugConfig: vscode.DebugConfiguration) {

          if ((folder.uri.scheme === 'ssh') && config) {
            debugConfig['request'] = 'attach';
            debugConfig['pathMappings'] = [];
            debugConfig['pathMappings'].push({ 'localRoot': 'ssh://' + config.name, 'remoteRoot': config.root });

            if (config.debugPort) {
              if (debugConfig['port'] && (debugConfig['port'] !== config.port))
                Logging.warning(`Invalid port in 'launch.json' working on '${config.name}'`);
              debugConfig['port'] = config.debugPort;

              if (debugConfig['host'] && (debugConfig['host'] !== config.host))
                Logging.warning(`Invalid host in 'launch.json' working on '${config.name}'`);
              debugConfig['host'] = config.host;
            }

            if (debugConfig['port'] === undefined)
              Logging.error(`Missing property "debugPort" for remote debugging on '${config.name}'`);

            let workspaceFolder = root;
            let file = "${file}"; // default to get error message to open an editor
            if (vscode.window.activeTextEditor)
              file = root + vscode.window.activeTextEditor.document.uri.path; // '${file}' can not be resolved per default              
            if (debugConfig['program'])
              debugConfig['program'] = eval('`' + debugConfig['program'] + '`'); // resolve ${file}, ${workspaceFolder}   
            else
              debugConfig['program'] = file;  
          }                      
          return debugConfig;
        }
      });

     
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscode.DebugSession) {
          if (config && config.debugPreLaunch) {
            return {
              onWillStartSession: () => {                
                if (config && config.debugPreLaunch) {                 
                  const file = session.configuration['program'];                  
                  const command = eval('`' + config.debugPreLaunch + '`'); // resolve ${file} and config.              
                  
                  new Promise((resolve, reject) => {
                    Logging.info(`Start preLaunch Task for remote debugging: ${command}`);
                    client.exec(command, (err, stream) => {
                      if (err) return reject(err);
                      stream.stderr.on('data', (d) => {
                        Logging.error(`Stderr from remote debugging: ${d}`);
                      })
                      stream.on('data', (d) => {
                        Logging.debug(`Stdout from remote debugging: ${d}`);
                      })
                      stream.on('error', reject);
                      stream.on('close', (exitCode, signal) => {
                        if (exitCode || signal) {
                          return reject(new Error("error listing directory"));
                        }
                        resolve();
                      });
                    });
                  });
            }}};
          }}
      });

      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscode.DebugSession) {
          if (session.configuration['dapTrace']) {          
            return {
              onWillStartSession: () => console.log(`start: ${session.id}`),                  
              onWillReceiveMessage: m => console.log(`===> ${JSON.stringify(m, undefined, 2)}`),
              onDidSendMessage: m => console.log(`<=== ${JSON.stringify(m, undefined, 2)}`),
              onWillStopSession: () => console.log(`stop: ${session.id}`),
              onError: err => console.log(`error: ${err}`),
              onExit: (code, signal) => console.log(`exit: ${code}`)
            };
          }
        }
      });

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
        Logging.error(e);
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
  public getActive() {
    return this.fileSystems.map(fs => fs.config);
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
    this.onDidChangeTreeDataEmitter.fire();
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
    if (this.getActive().find(fs => fs.name === target)) return vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    const folders = vscode.workspace.workspaceFolders!;
    const folder = folders && folders.find(f => f.uri.scheme === 'ssh' && f.uri.authority === target);
    if (folder) {
      this.onDidChangeTreeDataEmitter.fire();
      return this.createFileSystem(target, config);
    }
    vscode.workspace.updateWorkspaceFolders(folders ? folders.length : 0, 0, { uri: vscode.Uri.parse(`ssh://${target}/`), name: `SSH FS - ${target}` });
    this.onDidChangeTreeDataEmitter.fire();
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
