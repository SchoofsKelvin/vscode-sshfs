import type { EnvironmentVariable, FileSystemConfig } from 'common/fileSystemConfig';
import { posix as path } from 'path';
import * as readline from 'readline';
import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { configMatches, loadConfigs } from './config';
import { getFlag, getFlagBoolean } from './flags';
import { Logging, LOGGING_NO_STACKTRACE } from './logging';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import { calculateShellConfig, KNOWN_SHELL_CONFIGS, ShellConfig, tryCommand, tryEcho } from './shellConfig';
import type { SSHFileSystem } from './sshFileSystem';
import { mergeEnvironment, toPromise } from './utils';

export interface Connection {
    config: FileSystemConfig;
    actualConfig: FileSystemConfig;
    client: Client;
    home: string;
    shellConfig: ShellConfig;
    environment: EnvironmentVariable[];
    terminals: SSHPseudoTerminal[];
    filesystems: SSHFileSystem[];
    cache: Record<string, any>;
    pendingUserCount: number;
    idleTimer: NodeJS.Timeout;
}

export class ConnectionManager {
    protected onConnectionAddedEmitter = new vscode.EventEmitter<Connection>();
    protected onConnectionRemovedEmitter = new vscode.EventEmitter<Connection>();
    protected onConnectionUpdatedEmitter = new vscode.EventEmitter<Connection>();
    protected onPendingChangedEmitter = new vscode.EventEmitter<void>();
    protected connections: Connection[] = [];
    protected pendingConnections: { [name: string]: [Promise<Connection>, FileSystemConfig | undefined] } = {};
    /** Fired when a connection got added (and finished connecting) */
    public readonly onConnectionAdded = this.onConnectionAddedEmitter.event;
    /** Fired when a connection got removed */
    public readonly onConnectionRemoved = this.onConnectionRemovedEmitter.event;
    /** Fired when a connection got updated (terminal added/removed, ...) */
    public readonly onConnectionUpdated = this.onConnectionUpdatedEmitter.event;
    /** Fired when a pending connection gets added/removed */
    public readonly onPendingChanged = this.onPendingChangedEmitter.event;
    public getActiveConnection(name: string, config?: FileSystemConfig): Connection | undefined {
        if (config) return this.connections.find(con => configMatches(con.config, config));
        name = name.toLowerCase();
        return this.connections.find(con => con.config.name === name);
    }
    public getActiveConnections(): Connection[] {
        return [...this.connections];
    }
    public getPendingConnections(): [string, FileSystemConfig | undefined][] {
        return Object.keys(this.pendingConnections).map(name => [name, this.pendingConnections[name][1]]);
    }
    protected async _createCommandTerminal(client: Client, shellConfig: ShellConfig, authority: string, debugLogging: boolean): Promise<string> {
        const logging = Logging.scope(`CmdTerm(${authority})`);
        if (!shellConfig.embedSubstitutions) throw new Error(`Shell '${shellConfig.shell}' does not support embedding substitutions`);
        const shell = await toPromise<ClientChannel>(cb => client.shell({}, cb));
        logging.debug(`TTY COMMAND: ${`echo ${shellConfig.embedSubstitutions`::sshfs:${'echo TTY'}:${'tty'}`}\n`}`);
        shell.write(`echo ${shellConfig.embedSubstitutions`::sshfs:${'echo TTY'}:${'tty'}`}\n`);
        return new Promise((resolvePath, rejectPath) => {
            setTimeout(() => rejectPath(new Error('Timeout fetching command path')), 10e3);
            const rl = readline.createInterface(shell);
            shell.once('error', rejectPath);
            shell.once('close', () => rejectPath());
            rl.on('line', async line => {
                if (debugLogging) logging.debug('<< ' + line);
                const [, prefix, cmd, args] = line.match(/(.*?)::sshfs:(\w+):(.*)$/) || [];
                if (!cmd || prefix.endsWith('echo ')) return;
                switch (cmd) {
                    case 'TTY':
                        logging.info('Got TTY path: ' + args);
                        resolvePath(args);
                        break;
                    case 'code':
                        let [pwd, target] = args.split(':::');
                        if (!pwd || !target) {
                            logging.error`Malformed 'code' command args: ${args}`;
                            return;
                        }
                        pwd = pwd.trim();
                        target = target.trim();
                        logging.info`Received command to open '${target}' while in '${pwd}'`;
                        const absolutePath = target.startsWith('/') ? target : path.join(pwd, target);
                        const uri = vscode.Uri.parse(`ssh://${authority}/${absolutePath}`);
                        try {
                            const stat = await vscode.workspace.fs.stat(uri);
                            if (stat.type & vscode.FileType.Directory) {
                                await vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri });
                            } else {
                                await vscode.window.showTextDocument(uri);
                            }
                        } catch (e) {
                            if (e instanceof vscode.FileSystemError) {
                                if (e.code === 'FileNotFound') {
                                    logging.warning(`File '${absolutePath}' not found, prompting to create empty file`);
                                    const choice = await vscode.window.showWarningMessage(`File '${absolutePath}' not found, create it?`, { modal: true }, 'Yes');
                                    if (choice !== 'Yes') return;
                                    try { await vscode.workspace.fs.writeFile(uri, Buffer.of()); } catch (e) {
                                        logging.error(e);
                                        vscode.window.showErrorMessage(`Failed to create an empty file at '${absolutePath}'`);
                                        return;
                                    }
                                    await vscode.window.showTextDocument(uri);
                                    return;
                                }
                                vscode.window.showErrorMessage(`Error opening ${absolutePath}: ${e.name.replace(/ \(FileSystemError\)/g, '')}`);
                            } else {
                                vscode.window.showErrorMessage(`Error opening ${absolutePath}: ${e.message || e}`);
                            }
                        }
                        return;
                    default:
                        logging.error`Unrecognized command ${cmd} with args: ${args}`;
                }
            });
        })
    }
    protected async _createConnection(name: string, config?: FileSystemConfig): Promise<Connection> {
        const logging = Logging.scope(`createConnection(${name},${config ? 'config' : 'undefined'})`);
        logging.info`Creating a new connection for '${name}'`;
        const { createSSH, calculateActualConfig } = await import('./connect');
        // Query and calculate the actual config
        config = config || (await loadConfigs()).find(c => c.name === name);
        if (!config) throw new Error(`No configuration with name '${name}' found`);
        const actualConfig = await calculateActualConfig(config);
        if (!actualConfig) throw new Error('Connection cancelled');
        // Start the actual SSH connection
        const client = await createSSH(actualConfig);
        if (!client) throw new Error(`Could not create SSH session for '${name}'`);
        logging.info`Remote version: ${(client as any)._remoteVer || 'N/A'}`;
        // Calculate shell config
        let shellConfig: ShellConfig;
        const [flagSCV, flagSCR] = getFlag("SHELL_CONFIG", config.flags) || [];
        if (flagSCV && typeof flagSCV === 'string') {
            logging.info`Using forced shell config '${flagSCV}' set by ${flagSCR}`;
            shellConfig = KNOWN_SHELL_CONFIGS[flagSCV];
            if (!shellConfig) throw new Error(`The forced shell config '${flagSCV}' does not exist`);
        } else {
            shellConfig = await calculateShellConfig(client, logging);
        }
        // Query home directory
        let home: string | Error | null;
        if (shellConfig.isWindows) {
            home = await tryCommand(client, "echo %USERPROFILE%").catch((e: Error) => e);
            if (home === null) home = new Error(`No output for "echo %USERPROFILE%"`);
            if (typeof home === 'string') home = home.trim();
            if (home === "%USERPROFILE%") home = new Error(`Non-substituted output for "echo %USERPROFILE%"`);
        } else {
            home = await tryEcho(client, shellConfig, '~').catch((e: Error) => e);
        }
        if (typeof home !== 'string') {
            const [flagCH] = getFlagBoolean('CHECK_HOME', true, config.flags);
            logging.error('Could not detect home directory', LOGGING_NO_STACKTRACE);
            if (flagCH) {
                if (home) logging.error(home);
                logging.info('If this is expected, disable the CHECK_HOME flag with \'-CHECK_HOME\':');
                logging.info('https://github.com/SchoofsKelvin/vscode-sshfs/issues/270');
                await vscode.window.showErrorMessage(`Couldn't detect the home directory for '${name}'`, 'Okay');
                throw new Error(`Could not detect home directory`);
            } else {
                if (home) logging.warning(home);
                logging.warning('The CHECK_HOME flag is disabled, default to \'/\' and ignore the error');
                home = '';
            }
        }
        logging.debug`Home path: ${home}`;
        // Calculate the environment
        const environment: EnvironmentVariable[] = mergeEnvironment([], config.environment);
        // Set up stuff for receiving remote commands
        const [flagRCV, flagRCR] = getFlagBoolean('REMOTE_COMMANDS', false, actualConfig.flags);
        if (flagRCV) {
            const [flagRCDV, flagRCDR] = getFlagBoolean('DEBUG_REMOTE_COMMANDS', false, actualConfig.flags);
            const withDebugStr = flagRCDV ? ` with debug logging enabled by '${flagRCDR}'` : '';
            logging.info`Flag REMOTE_COMMANDS provided in '${flagRCR}', setting up command terminal${withDebugStr}`;
            if (shellConfig.isWindows) {
                logging.error(`Windows detected, command terminal is not yet supported`, LOGGING_NO_STACKTRACE);
            } else {
                const cmdPath = await this._createCommandTerminal(client, shellConfig, name, flagRCDV);
                environment.push({ key: 'KELVIN_SSHFS_CMD_PATH', value: cmdPath });
            }
        }
        logging.debug`Environment: ${environment}`;
        // Set up the Connection object
        let timeoutCounter = 0;
        const con: Connection = {
            config, client, actualConfig, home, shellConfig, environment,
            terminals: [],
            filesystems: [],
            cache: {},
            pendingUserCount: 0,
            idleTimer: setInterval(() => { // Automatically close connection when idle for a while
                timeoutCounter = timeoutCounter ? timeoutCounter - 1 : 0;
                if (con.pendingUserCount) return; // Still got starting filesystems/terminals on this connection
                con.filesystems = con.filesystems.filter(fs => !fs.closed && !fs.closing);
                if (con.filesystems.length) return; // Still got active filesystems on this connection
                if (con.terminals.length) return; // Still got active terminals on this connection
                if (timeoutCounter !== 1) return timeoutCounter = 2;
                // timeoutCounter === 1, so it's been inactive for at least 5 seconds, close it!
                this.closeConnection(con, 'Idle with no active filesystems/terminals');
            }, 5e3),
        };
        this.connections.push(con);
        this.onConnectionAddedEmitter.fire(con);
        return con;
    }
    public async createConnection(name: string, config?: FileSystemConfig): Promise<Connection> {
        const con = this.getActiveConnection(name, config);
        if (con) return con;
        let pending = this.pendingConnections[name];
        if (pending) return pending[0];
        pending = [this._createConnection(name, config), config];
        this.pendingConnections[name] = pending;
        this.onPendingChangedEmitter.fire();
        pending[0].finally(() => {
            delete this.pendingConnections[name];
            this.onPendingChangedEmitter.fire();
        });
        return pending[0];
    }
    public closeConnection(connection: Connection, reason?: string) {
        const index = this.connections.indexOf(connection);
        if (index === -1) return;
        reason = reason ? `'${reason}' as reason` : ' no reason given';
        Logging.info`Closing connection to '${connection.actualConfig.name}' with ${reason}`;
        this.connections.splice(index, 1);
        clearInterval(connection.idleTimer);
        this.onConnectionRemovedEmitter.fire(connection);
        connection.client.end();
    }
    // Without making createConnection return a Proxy, or making Connection a class with
    // getters and setters informing the manager that created it, we don't know if it updated.
    // So stuff that updates connections should inform us by calling this method.
    // (currently the only thing this matters for is the 'sshfs-connections' tree view)
    // The updater callback just allows for syntactic sugar e.g. update(con, con => modifyCon(con))
    public update(connection: Connection, updater?: (con: Connection) => void) {
        updater?.(connection);
        this.onConnectionUpdatedEmitter.fire(connection);
    }
}
