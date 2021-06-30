import type { Client, ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { configMatches, getFlagBoolean, loadConfigs } from './config';
import type { EnvironmentVariable, FileSystemConfig } from './fileSystemConfig';
import { Logging } from './logging';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import type { SSHFileSystem } from './sshFileSystem';
import { toPromise } from './toPromise';

export interface Connection {
    config: FileSystemConfig;
    actualConfig: FileSystemConfig;
    client: Client;
    home: string;
    environment: EnvironmentVariable[];
    terminals: SSHPseudoTerminal[];
    filesystems: SSHFileSystem[];
    pendingUserCount: number;
    idleTimer: NodeJS.Timeout;
}

export function mergeEnvironment(env: EnvironmentVariable[], ...others: (EnvironmentVariable[] | Record<string, string> | undefined)[]): EnvironmentVariable[] {
    const result = [...env];
    for (const other of others) {
        if (!other) continue;
        if (Array.isArray(other)) {
            for (const variable of other) {
                const index = result.findIndex(v => v.key === variable.key);
                if (index === -1) result.push(variable);
                else result[index] = variable;
            }
        } else {
            for (const [key, value] of Object.entries(other)) {
                result.push({ key, value });
            }
        }
    }
    return result;
}

// https://stackoverflow.com/a/20053121 way 1
const CLEAN_BASH_VALUE_REGEX = /^[\w-/\\]+$/;
function escapeBashValue(value: string) {
    if (CLEAN_BASH_VALUE_REGEX.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function environmentToExportString(env: EnvironmentVariable[]): string {
    return env.map(({ key, value }) => `export ${escapeBashValue(key)}=${escapeBashValue(value)}`).join('; ');
}

export function joinCommands(commands: string | string[] | undefined, separator: string): string | undefined {
    if (!commands) return undefined;
    if (typeof commands === 'string') return commands;
    return commands.filter(c => c && c.trim()).join(separator);
}

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
        const con = config && this.connections.find(con => configMatches(con.config, config));
        return con || (config ? undefined : this.connections.find(con => con.config.name === name));
    }
    public getActiveConnections(): Connection[] {
        return [...this.connections];
    }
    public getPendingConnections(): [string, FileSystemConfig | undefined][] {
        return Object.keys(this.pendingConnections).map(name => [name, this.pendingConnections[name][1]]);
    }
    protected async _createConnection(name: string, config?: FileSystemConfig): Promise<Connection> {
        const logging = Logging.scope(`createConnection(${name},${config ? 'config' : 'undefined'})`);
        logging.info(`Creating a new connection for '${name}'`);
        const { createSSH, calculateActualConfig } = await import('./connect');
        // Query and calculate the actual config
        config = config || (await loadConfigs()).find(c => c.name === name);
        if (!config) throw new Error(`No configuration with name '${name}' found`);
        const actualConfig = await calculateActualConfig(config);
        if (!actualConfig) throw new Error('Connection cancelled');
        // Start the actual SSH connection
        const client = await createSSH(actualConfig);
        if (!client) throw new Error(`Could not create SSH session for '${name}'`);
        // Query home directory
        const home = await tryGetHome(client);
        if (!home) {
            await vscode.window.showErrorMessage(`Couldn't detect the home directory for '${name}'`, 'Okay');
            throw new Error(`Could not detect home directory`);
        }
        // Calculate the environment
        const environment: EnvironmentVariable[] = mergeEnvironment([], config.environment);
        // Set up the Connection object
        let timeoutCounter = 0;
        const con: Connection = {
            config, client, actualConfig, home, environment,
            terminals: [],
            filesystems: [],
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
        Logging.info(`Closing connection to '${connection.actualConfig.name}' with ${reason}`);
        this.connections.splice(index, 1);
        clearInterval(connection.idleTimer);
        this.onConnectionRemovedEmitter.fire(connection);
        connection.client.destroy();
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
