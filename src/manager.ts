
import * as path from 'path';
import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { getConfig, getConfigs, loadConfigsRaw } from './config';
import { Connection, ConnectionManager } from './connection';
import type { FileSystemConfig } from './fileSystemConfig';
import { Logging } from './logging';
import { isSSHPseudoTerminal } from './pseudoTerminal';
import type { SSHFileSystem } from './sshFileSystem';
import { catchingPromise, toPromise } from './toPromise';
import type { Navigation } from './webviewMessages';

async function tryGetHome(ssh: Client): Promise<string | null> {
  const exec = await toPromise<ClientChannel>(cb => ssh.exec('echo Home: ~', cb));
  let home = '';
  exec.stdout.on('data', (chunk: any) => home += chunk);
  await toPromise(cb => exec.on('close', cb));
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

interface SSHShellTaskOptions extends vscode.TaskDefinition {
  host: string;
  command: string;
  workingDirectory?: string;
}

interface TerminalLinkUri extends vscode.TerminalLink {
  uri?: vscode.Uri;
}

export class Manager implements vscode.TaskProvider, vscode.TerminalLinkProvider<TerminalLinkUri> {
  protected fileSystems: SSHFileSystem[] = [];
  protected creatingFileSystems: { [name: string]: Promise<SSHFileSystem> } = {};
  public readonly connectionManager = new ConnectionManager();
  constructor(public readonly context: vscode.ExtensionContext) {
    // In a multi-workspace environment, when the non-main folder gets removed,
    // it might be one of ours, which we should then disconnect if it's
    // the only one left for the given config (name)
    // When one gets added, it gets connected on-demand (using stat() etc)
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      const { workspaceFolders = [] } = vscode.workspace;
      e.removed.forEach(async (folder) => {
        if (folder.uri.scheme !== 'ssh') return;
        if (workspaceFolders.find(f => f.uri.authority === folder.uri.authority)) return;
        const fs = this.fileSystems.find(fs => fs.authority === folder.uri.authority);
        if (fs) fs.disconnect();
      });
    });
  }
  public async createFileSystem(name: string, config?: FileSystemConfig): Promise<SSHFileSystem> {
    const existing = this.fileSystems.find(fs => fs.authority === name);
    if (existing) return existing;
    let con: Connection | undefined;
    return this.creatingFileSystems[name] ||= catchingPromise<SSHFileSystem>(async (resolve, reject) => {
      config = config || getConfigs().find(c => c.name === name);
      if (!config) throw new Error(`Couldn't find a configuration with the name '${name}'`);
      const con = await this.connectionManager.createConnection(name, config);
      this.connectionManager.update(con, con => con.pendingUserCount++);
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
      this.connectionManager.update(con, con => con.filesystems.push(fs));
      this.fileSystems.push(fs);
      delete this.creatingFileSystems[name];
      fs.onClose(() => {
        this.fileSystems = this.fileSystems.filter(f => f !== fs);
        this.connectionManager.update(con, con => con.filesystems = con.filesystems.filter(f => f !== fs));
      });
      vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      // con.client.once('close', hadError => !fs.closing && this.promptReconnect(name));
      this.connectionManager.update(con, con => con.pendingUserCount--);
      return resolve(fs);
    }).catch((e) => {
      if (con) this.connectionManager.update(con, con => con.pendingUserCount--); // I highly doubt resolve(fs) will error
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
  public getRemotePath(config: FileSystemConfig, relativePath: string | vscode.Uri) {
    if (relativePath instanceof vscode.Uri) {
      if (relativePath.authority !== config.name)
        throw new Error(`Uri authority for '${relativePath}' does not match config with name '${config.name}'`);
      relativePath = relativePath.path;
    }
    if (relativePath.startsWith('/')) relativePath = relativePath.substr(1);
    if (!config.root) return '/' + relativePath;
    const result = path.posix.join(config.root, relativePath);
    if (result.startsWith('~')) return result; // Home directory, leave the ~/
    if (result.startsWith('/')) return result; // Already starts with /
    return '/' + result; // Add the / to make sure it isn't seen as a relative path
  }
  public async createTerminal(name: string, config?: FileSystemConfig | Connection, uri?: vscode.Uri): Promise<void> {
    const { createTerminal } = await import('./pseudoTerminal');
    // Create connection (early so we have .actualConfig.root)
    const con = (config && 'client' in config) ? config : await this.connectionManager.createConnection(name, config);
    // Calculate working directory if applicable
    const workingDirectory = uri && this.getRemotePath(con.actualConfig, uri);
    // Create pseudo terminal
    this.connectionManager.update(con, con => con.pendingUserCount++);
    const pty = await createTerminal({ client: con.client, config: con.actualConfig, workingDirectory });
    pty.onDidClose(() => this.connectionManager.update(con, con => con.terminals = con.terminals.filter(t => t !== pty)));
    this.connectionManager.update(con, con => (con.terminals.push(pty), con.pendingUserCount--));
    // Create and show the graphical representation
    const terminal = vscode.window.createTerminal({ name, pty });
    pty.terminal = terminal;
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
    const choice = await vscode.window.showWarningMessage(`SSH FS ${config.label || config.name} disconnected`, 'Ignore', 'Disconnect');
    if (choice === 'Disconnect') this.commandDisconnect(name);
  }
  /* TaskProvider */
  protected async replaceTaskVariables(value: string, config: FileSystemConfig): Promise<string> {
    return value.replace(/\$\{(\w+)\}/g, (str, match: string) => {
      if (!match.startsWith('remote')) return str; // Our variables always start with "remote"
      // https://github.com/microsoft/vscode/blob/bebd06640734c37f6d5f1a82b13297ce1d297dd1/src/vs/workbench/services/configurationResolver/common/variableResolver.ts#L156
      const [key, argument] = match.split(':') as [string, string?];
      const getFilePath = (): vscode.Uri => {
        const uri = vscode.window.activeTextEditor?.document?.uri;
        if (uri) return uri;
        throw new Error(`Variable ${str} can not be resolved. Please open an editor.`);
      }
      const getFolderPathForFile = (): vscode.Uri => {
        const filePath = getFilePath();
        const uri = vscode.workspace.getWorkspaceFolder(filePath)?.uri;
        if (uri) return uri;
        throw new Error(`Variable ${str}: can not find workspace folder of '${filePath}'.`);
      }
      const { workspaceFolders = [] } = vscode.workspace;
      const sshFolders = workspaceFolders.filter(ws => ws.uri.scheme === 'ssh');
      const sshFolder = sshFolders.length === 1 ? sshFolders[0] : undefined;
      const getFolderUri = (): vscode.Uri => {
        const { workspaceFolders = [] } = vscode.workspace;
        if (argument) {
          const uri = workspaceFolders.find(ws => ws.name === argument)?.uri;
          if (uri) return uri;
          throw new Error(`Variable ${str} can not be resolved. No such folder '${argument}'.`);
        }
        if (sshFolder) return sshFolder.uri;
        if (sshFolders.length > 1) {
          throw new Error(`Variable ${str} can not be resolved in a multi ssh:// folder workspace. Scope this variable using ':' and a workspace folder name.`);
        }
        throw new Error(`Variable ${str} can not be resolved. Please open an ssh:// folder.`);
      };
      switch (key.toLowerCase()) {
        case 'remoteWorkspaceRoot':
        case 'remoteWorkspaceFolder':
          return this.getRemotePath(config, getFolderUri());
        case 'remoteWorkspaceRootFolderName':
        case 'remoteWorkspaceFolderBasename':
          return path.basename(getFolderUri().path);
        case 'remoteFile':
          return this.getRemotePath(config, getFilePath());
        case 'remoteFileWorkspaceFolder':
          return this.getRemotePath(config, getFolderPathForFile());
        case 'remoteRelativeFile':
          if (sshFolder || argument)
            return path.relative(getFolderUri().path, getFilePath().path);
          return getFilePath().path;
        case 'remoteRelativeFileDirname': {
          const dirname = path.dirname(getFilePath().path);
          if (sshFolder || argument) {
            const relative = path.relative(getFolderUri().path, dirname);
            return relative.length === 0 ? '.' : relative;
          }
          return dirname;
        }
        case 'remoteFileDirname':
          return path.dirname(getFilePath().path);
        case 'remoteFileExtname':
          return path.extname(getFilePath().path);
        case 'remoteFileBasename':
          return path.basename(getFilePath().path);
        case 'remoteFileBasenameNoExtension': {
          const basename = path.basename(getFilePath().path);
          return (basename.slice(0, basename.length - path.extname(basename).length));
        }
        case 'remoteFileDirnameBasename':
          return path.basename(path.dirname(getFilePath().path));
        case 'remotePathSeparator':
          // Not sure if we even need/want this variable, but sure
          return path.posix.sep;
        default:
          const msg = `Unrecognized task variable '${str}' starting with 'remote', ignoring`;
          Logging.warning(msg);
          vscode.window.showWarningMessage(msg);
          return str;
      }
    });
  }
  protected async replaceTaskVariablesRecursive<T>(object: T, handler: (value: string) => string | Promise<string>): Promise<T> {
    if (typeof object === 'string') return handler(object) as any;
    if (Array.isArray(object)) return object.map(v => this.replaceTaskVariablesRecursive(v, handler)) as any;
    if (typeof object == 'object' && object !== null && !(object instanceof RegExp) && !(object instanceof Date)) {
      // ^ Same requirements VS Code applies: https://github.com/microsoft/vscode/blob/bebd06640734c37f6d5f1a82b13297ce1d297dd1/src/vs/base/common/types.ts#L34
      const result: any = {};
      for (let key in object) {
        const value = await this.replaceTaskVariablesRecursive(object[key], handler);
        key = await this.replaceTaskVariablesRecursive(key, handler);
        result[key] = value;
      }
      return result;
    }
    return object;
  }
  public provideTasks(token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.Task[]> {
    return [];
  }
  public async resolveTask(task: vscode.Task, token?: vscode.CancellationToken | undefined): Promise<vscode.Task> {
    return new vscode.Task(
      task.definition, // Can't replace/modify this, otherwise we're not contributing to "this" task
      vscode.TaskScope.Workspace,
      `SSH Task '${task.name}'`,
      'ssh',
      new vscode.CustomExecution(async (resolved: SSHShellTaskOptions) => {
        const { createTerminal, createTextTerminal } = await import('./pseudoTerminal');
        try {
          if (!resolved.host) throw new Error('Missing field \'host\' in task description');
          if (!resolved.command) throw new Error('Missing field \'command\' in task description');
          const connection = await this.connectionManager.createConnection(resolved.host);
          resolved = await this.replaceTaskVariablesRecursive(resolved, value => this.replaceTaskVariables(value, connection.actualConfig));
          const { command, workingDirectory } = resolved;
          //if (workingDirectory) workingDirectory = this.getRemotePath(config, workingDirectory);
          this.connectionManager.update(connection, con => con.pendingUserCount++);
          const pty = await createTerminal({
            command, workingDirectory,
            client: connection.client,
            config: connection.actualConfig,
          });
          this.connectionManager.update(connection, con => (con.pendingUserCount--, con.terminals.push(pty)));
          pty.onDidClose(() => this.connectionManager.update(connection,
            con => con.terminals = con.terminals.filter(t => t !== pty)));
          return pty;
        } catch (e) {
          return createTextTerminal(`Error: ${e.message || e}`);
        }
      })
    )
  }
  /* TerminalLinkProvider */
  public provideTerminalLinks(context: vscode.TerminalLinkContext, token: vscode.CancellationToken): TerminalLinkUri[] | undefined {
    const { line, terminal } = context;
    const { creationOptions } = terminal;
    if (!('pty' in creationOptions)) return;
    const { pty } = creationOptions;
    if (!isSSHPseudoTerminal(pty)) return;
    const conn = this.connectionManager.getActiveConnections().find(c => c.terminals.includes(pty));
    if (!conn) return; // Connection died, which means the terminal should also be closed already?
    console.log('provideTerminalLinks', line, pty.config.root, conn ? conn.filesystems.length : 'No connection?');
    const links: TerminalLinkUri[] = [];
    const PATH_REGEX = /\/\S+/g;
    while (true) {
      const match = PATH_REGEX.exec(line);
      if (!match) break;
      const [filepath] = match;
      let relative: string | undefined;
      for (const fs of conn.filesystems) {
        const rel = path.posix.relative(fs.root, filepath);
        if (!rel.startsWith('../') && !path.posix.isAbsolute(rel)) {
          relative = rel;
          break;
        }
      }
      const uri = relative ? vscode.Uri.parse(`ssh://${conn.actualConfig.name}/${relative}`) : undefined;
      // TODO: Support absolute path stuff, maybe `ssh://${conn.actualConfig.name}:root//${filepath}` or so?
      links.push({
        uri,
        startIndex: match.index,
        length: filepath.length,
        tooltip: uri ? '[SSH FS] Open file' : '[SSH FS] Cannot open remote file outside configured root directory',
      });
    }
    return links;
  }
  public async handleTerminalLink(link: TerminalLinkUri): Promise<void> {
    if (!link.uri) return;
    await vscode.window.showTextDocument(link.uri);
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
    const folders = vscode.workspace.workspaceFolders || [];
    let start: number = folders.length;
    let left: vscode.WorkspaceFolder[] = [];
    for (const folder of folders) {
      if (folder.uri.scheme === 'ssh' && folder.uri.authority === target) {
        start = Math.min(folder.index, start);
      } else if (folder.index > start) {
        left.push(folder);
      }
    };
    if (folders.length === left.length) return;
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
    const { open, navigate } = await import('./webview');
    return navigation ? navigate(navigation) : open();
  }
}
