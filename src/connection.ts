import type { Client } from 'ssh2';
import * as vscode from 'vscode';
import { configMatches, loadConfigs } from './config';
import type { FileSystemConfig } from './fileSystemConfig';
import { Logging } from './logging';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import type { SSHFileSystem } from './sshFileSystem';

export interface Connection {
    config: FileSystemConfig;
    actualConfig: FileSystemConfig;
    client: Client;
    terminals: SSHPseudoTerminal[];
    filesystems: SSHFileSystem[];
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
        config = config || (await loadConfigs()).find(c => c.name === name);
        if (!config) throw new Error(`No configuration with name '${name}' found`);
        const actualConfig = await calculateActualConfig(config);
        if (!actualConfig) throw new Error('Connection cancelled');
        const client = await createSSH(actualConfig);
        if (!client) throw new Error(`Could not create SSH session for '${name}'`);
        let timeoutCounter = 0;
        const con: Connection = {
            config, client, actualConfig,
            terminals: [],
            filesystems: [],
            pendingUserCount: 0,
            idleTimer: setInterval(() => { // Automatically close connection when idle for a while
                timeoutCounter = timeoutCounter ? timeoutCounter - 1 : 0;
                if (con.pendingUserCount) return;
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
