
import * as path from 'path';
import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { getConfig, getFlagBoolean, loadConfigsRaw } from './config';
import { Connection, ConnectionManager } from './connection';
import type { FileSystemConfig } from './fileSystemConfig';
import { getRemotePath } from './fileSystemRouter';
import { Logging, LOGGING_NO_STACKTRACE } from './logging';
import { isSSHPseudoTerminal, replaceVariables, replaceVariablesRecursive } from './pseudoTerminal';
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
      config ||= getConfig(name);
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
          this.commandConfigure(config || name);
        } else {
          this.commandDisconnect(name);
        }
      });
      throw e;
    });
  }
  public async createTerminal(name: string, config?: FileSystemConfig | Connection, uri?: vscode.Uri): Promise<void> {
    const { createTerminal } = await import('./pseudoTerminal');
    // Create connection (early so we have .actualConfig.root)
    const con = (config && 'client' in config) ? config : await this.connectionManager.createConnection(name, config);
    // Calculate working directory if applicable
    const workingDirectory = uri && getRemotePath(con.actualConfig, uri);
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
    if (!config) return;
    const choice = await vscode.window.showWarningMessage(`SSH FS ${config.label || config.name} disconnected`, 'Ignore', 'Disconnect');
    if (choice === 'Disconnect') this.commandDisconnect(name);
  }
  /* TaskProvider */
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
        const { createTerminal, createTextTerminal, joinCommands } = await import('./pseudoTerminal');
        try {
          if (!resolved.host) throw new Error('Missing field \'host\' in task description');
          if (!resolved.command) throw new Error('Missing field \'command\' in task description');
          const connection = await this.connectionManager.createConnection(resolved.host);
          resolved = await replaceVariablesRecursive(resolved, value => replaceVariables(value, connection.actualConfig));
          let { command, workingDirectory } = resolved;
          const [useWinCmdSep] = getFlagBoolean('WINDOWS_COMMAND_SEPARATOR', false, connection.actualConfig.flags);
          const separator = useWinCmdSep ? ' && ' : '; ';
          let { taskCommand = '$COMMAND' } = connection.actualConfig;
          taskCommand = joinCommands(taskCommand, separator)!;
          if (taskCommand.includes('$COMMAND')) {
            command = taskCommand.replace(/\$COMMAND/g, command);
          } else {
            const message = `The taskCommand '${taskCommand}' is missing the '$COMMAND' placeholder!`;
            Logging.warning(message, LOGGING_NO_STACKTRACE);
            command = `echo "Missing '$COMMAND' placeholder"`;
          }
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
    const others = this.connectionManager.getActiveConnections().filter(c => c.actualConfig.name === target);
    if (others && others.some(c => c.filesystems.length)) return;
    // No other filesystems of the same name left anymore, so remove all related workspace folders
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
      if (!target._location && !target._locations.length) {
        vscode.window.showErrorMessage('Cannot configure a config-less connection!');
        return;
      }
      this.openSettings({ config: target, type: 'editconfig' });
      return;
    }
    target = target.toLowerCase();
    let configs = await loadConfigsRaw();
    configs = configs.filter(c => c.name === target);
    if (configs.length === 0) {
      vscode.window.showErrorMessage(`Found no matching configs for '${target}'`);
      return Logging.error(`Unexpectedly found no matching configs for '${target}' in commandConfigure?`);
    }
    const config = configs.length === 1 ? configs[0] : configs;
    this.openSettings({ config, type: 'editconfig' });
  }
  public async openSettings(navigation?: Navigation) {
    const { open, navigate } = await import('./webview');
    return navigation ? navigate(navigation) : open();
  }
}
