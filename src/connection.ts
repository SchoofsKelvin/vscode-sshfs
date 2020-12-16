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
    protected connections: Connection[] = [];
    protected pendingConnections: { [name: string]: Promise<Connection> } = {};
    public readonly onConnectionAdded = this.onConnectionAddedEmitter.event;
    public readonly onConnectionRemoved = this.onConnectionRemovedEmitter.event;
    public getActiveConnection(name: string, config?: FileSystemConfig): Connection | undefined {
        const con = config && this.connections.find(con => configMatches(con.config, config));
        return con || (config ? undefined : this.connections.find(con => con.config.name === name));
    }
    public getActiveConnections(): Connection[] {
        return [...this.connections];
    }
        const logging = Logging.scope(`createConnection(${name},${config ? 'config' : 'undefined'})`);
        const con = this.getActiveConnection(name, config);
        if (con) return con;
        return this.pendingConnections[name] ||= (async (): Promise<Connection> => {
            logging.info(`Creating a new connection for '${name}'`);
            const { createSSH, calculateActualConfig } = await import('./connect');
            config = config || (await loadConfigs()).find(c => c.name === name);
            if (!config) throw new Error(`No configuration with name '${name}' found`);
            const actualConfig = await calculateActualConfig(config);
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
        })().finally(() => delete this.pendingConnections[name]);
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
}
