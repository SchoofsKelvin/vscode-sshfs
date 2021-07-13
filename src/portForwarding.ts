import { getIP } from 'ip-matching';
import * as net from 'net';
import type { ClientChannel, TcpConnectionDetails, UnixConnectionDetails } from 'ssh2';
import type { Duplex } from 'stream';
import * as vscode from 'vscode';
import type { Connection } from "./connection";
import type { FileSystemConfig } from './fileSystemConfig';
import { Logging, LOGGING_NO_STACKTRACE } from './logging';
import type { Manager } from './manager';
import { capitalize, promptQuickPick } from './ui-utils';
import { toPromise } from './utils';

/** Represents a dynamic port forwarding (DynamicForward) */
export interface PortForwardingDynamic {
    type: 'dynamic';
    port: number;
    address?: string;
}

/** Represents a local (LocalForward) or remote (RemoteForward) port forwarding */
export interface PortForwardingLocalRemote {
    type: 'local' | 'remote';
    /** Represents the local port to use, or undefined for a Unix socket */
    localPort?: number;
    /** Represents the (optional) local bind address, or the Unix socket path if `localPort` is undefined */
    localAddress?: string;
    /** Represents the remote port to use, or undefined for a Unix socket */
    remotePort?: number;
    /** Represents the (optional) remote bind address, or the Unix socket path if `remotePort` is undefined */
    remoteAddress?: string;
}

export type PortForwarding = PortForwardingDynamic | PortForwardingLocalRemote;

type Disconnect = () => void;
export type ActivePortForwarding = [data: PortForwarding, connection: Connection, disconnect: Disconnect];
export function isActivePortForwarding(apf: any): apf is ActivePortForwarding {
    return Array.isArray(apf) && apf.length === 3 && 'type' in apf[0];
}

function validateLocalRemoteForwarding(forwarding: PortForwardingLocalRemote) {
    if (forwarding.localPort === undefined && !forwarding.localAddress) {
        throw new Error(`Missing both 'localPort' and 'localAddress' fields for a ${forwarding.type} port forwarding`);
    }
    if (forwarding.remotePort === undefined && !forwarding.remoteAddress) {
        throw new Error(`Missing both 'remotePort' and 'remoteAddress' fields for a ${forwarding.type} port forwarding`);
    }
}

async function createLocalForwarding(connection: Connection, forwarding: PortForwardingLocalRemote): Promise<ActivePortForwarding> {
    validateLocalRemoteForwarding(forwarding);
    if (forwarding.localAddress === '*') forwarding = { ...forwarding, localAddress: undefined };
    const { client } = connection;
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        if (forwarding.remotePort === undefined) {
            client.openssh_forwardOutStreamLocal(forwarding.remoteAddress!, (err, channel) => {
                if (err) return socket.destroy(err);
                socket.pipe(channel).pipe(socket);
            });
        } else {
            client.forwardOut('localhost', 0, forwarding.remoteAddress!, forwarding.remotePort!, (err, channel) => {
                if (err) return socket.destroy(err);
                socket.pipe(channel).pipe(socket);
            });
        }
    });
    if (forwarding.localPort === undefined) {
        await toPromise(cb => server.listen(forwarding.localAddress!, cb));
    } else {
        await toPromise(cb => server.listen(forwarding.localPort, forwarding.localAddress, cb));
        if (forwarding.localPort === 0) {
            forwarding = { ...forwarding, localPort: (server.address() as net.AddressInfo).port };
        }
    }
    return [forwarding, connection, () => server.close(() => sockets.forEach(s => s.destroy()))];
}

async function createRemoteForwarding(connection: Connection, forwarding: PortForwardingLocalRemote): Promise<ActivePortForwarding> {
    validateLocalRemoteForwarding(forwarding);
    const channels = new Set<Duplex>();
    const onSocket = (channel: Duplex) => {
        channels.add(channel);
        channel.on('close', () => channels.delete(socket));
        let socket: net.Socket;
        if (forwarding.localPort === undefined) {
            socket = net.createConnection(forwarding.localAddress!);
        } else {
            socket = net.createConnection(forwarding.localPort!, forwarding.localAddress!);
        }
        socket.on('connect', () => socket.pipe(channel).pipe(socket));
    };
    let unlisten: () => void;
    if (forwarding.remotePort === undefined) {
        await toPromise(cb => connection.client.openssh_forwardInStreamLocal(forwarding.remoteAddress!, cb));
        const listener = (details: UnixConnectionDetails, accept: () => ClientChannel) => {
            if (details.socketPath !== forwarding.remoteAddress) return;
            onSocket(accept());
        };
        connection.client.on('unix connection', listener);
        unlisten = () => connection.client.off('unix connection', listener);
    } else {
        const remotePort = await toPromise<number>(cb => connection.client.forwardIn(forwarding.remoteAddress!, forwarding.remotePort!, cb));
        forwarding = { ...forwarding, remotePort };
        const listener = (details: TcpConnectionDetails, accept: () => ClientChannel) => {
            if (details.destPort !== forwarding.remotePort) return;
            if (details.destIP !== forwarding.remoteAddress) return;
            onSocket(accept());
        };
        connection.client.on('tcp connection', listener);
        unlisten = () => connection.client.off('tcp connection', listener);
    }
    return [forwarding, connection, () => {
        unlisten();
        if (forwarding.remotePort === undefined) {
            connection.client.openssh_unforwardInStreamLocal(forwarding.remoteAddress!);
        } else {
            connection.client.unforwardIn(forwarding.remoteAddress!, forwarding.remotePort!);
        }
        channels.forEach(s => s.destroy());
    }];
}

function validateDynamicForwarding(forwarding: PortForwardingDynamic) {
    const { port, address } = forwarding;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65565) {
        throw new Error(`Expected 'port' field to be an integer 0-65565 for a  ${forwarding.type} port forwarding`);
    }
    if (address !== undefined && typeof address !== 'string') {
        throw new Error(`Expected 'address' field to be undefined or a string for a ${forwarding.type} port forwarding`);
    }
}

async function createDynamicForwarding(connection: Connection, forwarding: PortForwardingDynamic): Promise<ActivePortForwarding> {
    validateDynamicForwarding(forwarding);
    // Default is localhost, so transform `undefined` to 'localhost'
    if (!forwarding.address) forwarding = { ...forwarding, address: 'localhost' };
    // But `undefined` in the net API means "any interface", so transform '*' into `undefined`
    if (forwarding.address === '*') forwarding = { ...forwarding, address: undefined };
    const logging = Logging.scope(`dynamic(${connection.actualConfig.name}:${forwarding.port})`);
    logging.info(`Setting up dynamic forwarding on ${forwarding.address || '*'}:${forwarding.port}`);
    const channels = new Set<Duplex>();
    let closed = false;
    const { Server, Command, Auth } = await import('node-socksv5');
    const server = new Server({ auths: [Auth.none()] }, async (info, accept, deny) => {
        if (closed) return deny();
        logging.debug(`Received ${Command[info.command]} command from ${info.source.ip}:${info.source.port} to ${info.destination.host}:${info.destination.port}`);
        if (info.command !== Command.CONNECT) {
            logging.error(`Received unsupported ${Command[info.command]} command from ${info.source.ip}:${info.source.port} to ${info.destination.host}:${info.destination.port}`);
            return deny();
        }
        let channel: ClientChannel | undefined;
        try {
            channel = await toPromise<ClientChannel>(cb => connection.client.forwardOut(info.source.ip, info.source.port, info.destination.host, info.destination.port, cb));
            const socket = await accept();
            channel.pipe(socket).pipe(channel);
        } catch (e) {
            if (channel) channel.destroy();
            logging.error(`Error connecting from ${info.source.ip}:${info.source.port} to ${info.destination.host}:${info.destination.port}:`, LOGGING_NO_STACKTRACE);
            logging.error(e);
            return deny();
        }
        channels.add(channel);
    });
    // The library does some weird thing where it creates a connection to the destination
    // and then makes accept() return that connection? Very weird and bad for our use
    // case, so we overwrite this internal method so accept() returns the original socket.
    const processConnection: (typeof server)['processConnection'] = async function(this: typeof server, socket, destination) {
        await this.sendSuccessConnection(socket, destination);
        return socket;
    };
    (server as any).processConnection = processConnection;
    const err = await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        server.listen(forwarding.port, forwarding.address);
    }).then(() => undefined, (e: NodeJS.ErrnoException) => e);
    if (err) {
        if (err.code === 'EADDRINUSE') {
            throw new Error(`Port ${forwarding.port} for interface ${forwarding.address} already in use`);
        }
        throw err;
    }
    const serverSocket = (server as any).serverSocket as net.Server;
    const aInfo = serverSocket.address();
    if (!aInfo || typeof aInfo !== 'object' || !('port' in aInfo))
        throw new Error(`Could not get bound address for SOCKSv5 server`);
    logging.info(`Server listening on ${aInfo.family === 'IPv6' ? `[${aInfo.address}]` : aInfo.address}:${aInfo.port}`);
    forwarding = { ...forwarding, port: aInfo.port, address: aInfo.address };
    return [forwarding, connection, () => {
        closed = true;
        serverSocket.close();
        channels.forEach(s => s.destroy());
    }];
}

function getFactory(type: PortForwarding['type']): (conn: Connection, pf: PortForwarding) => Promise<ActivePortForwarding> {
    switch (type) {
        case 'local': return createLocalForwarding;
        case 'remote': return createRemoteForwarding;
        case 'dynamic': return createDynamicForwarding;
        default:
            throw new Error(`Forwarding type '${type}' is not recognized`);
    }
}

export async function addForwarding(manager: Manager, connection: Connection, forwarding: PortForwarding): Promise<void> {
    const factory = getFactory(forwarding.type);
    manager.connectionManager.update(connection, c => c.pendingUserCount++);
    try {
        const active = await factory(connection, forwarding);
        manager.connectionManager.update(connection, c => {
            c.forwardings.push(active);
            c.pendingUserCount--;
        });
    } catch (e) {
        manager.connectionManager.update(connection, c => c.pendingUserCount--);
        throw e;
    }
}

/** Far from correct, but it's more of a simple validation against obvious mistakes */
const DOMAIN_REGEX = /^\S{2,63}(\.\S{2,63})*$/;
function validateHost(str: string): string | undefined {
    if (DOMAIN_REGEX.test(str)) return undefined;
    try {
        const ip = getIP(str);
        if (!ip) return 'Invalid IP / domain';
    } catch (e) {
        return e.message || 'Invalid IP / domain';
    }
}
const PIPE_REGEX = /^\\\\[\?\.]\\pipe\\.*$/;
function validatePipe(str: string): string | undefined {
    if (str.match(PIPE_REGEX)) return undefined;
    return 'Windows pipe path should start with \\\\?\\pipe\\ or \\\\.\\pipe\\';
}
function validatePort(str: string): string | undefined {
    try {
        const port = parseInt(str);
        if (port >= 0 && port < 2 ** 16) return undefined;
        return 'Port has to be in the range 0-65535';
    } catch (e) {
        return 'Invalid port';
    }
}
const SOCKET_REGEX = /^[/\\][^\0]+$/;
function validateSocketPath(str: string): string | undefined {
    if (str.match(SOCKET_REGEX)) return undefined;
    return 'Unix domain socket path should be a proper absolute file path';
}
async function promptAddressOrPath(location: 'local' | 'remote'): Promise<[port?: number, address?: string] | undefined> {
    const A = 'address:port';
    const B = 'socket path / pipe';
    const type = await promptQuickPick(`Use a ${location} address:port or Unix domain socket path / Windows pipe?`, [A, B] as const);
    if (!type) return undefined;
    if (type === A) {
        const addr = await vscode.window.showInputBox({ prompt: 'Address to use', validateInput: validateHost, placeHolder: 'IPv4 / IPv6 / domain' });
        const port = await vscode.window.showInputBox({ prompt: 'Port to use', validateInput: validatePort, placeHolder: '0-65535' });
        return port === undefined ? undefined : [parseInt(port), addr];
    } else if (location === 'local' && process.platform === 'win32') {
        const pipe = await vscode.window.showInputBox({ prompt: 'Pipe to use', validateInput: validatePipe, placeHolder: '\\\\?\\pipe\\...' });
        return pipe ? [, pipe] : undefined;
    } else {
        const path = await vscode.window.showInputBox({ prompt: 'Socket path to use', validateInput: validateSocketPath, placeHolder: '/tmp/socket' });
        return path ? [, path] : undefined;
    }
}

async function promptBindAddress(): Promise<[port: number, address?: string] | undefined> {
    const port = await vscode.window.showInputBox({ prompt: 'Port to bind to', validateInput: validatePort, placeHolder: '0-65535' });
    if (!port) return undefined; // String so '0' is still truthy
    const addr = await vscode.window.showInputBox({ prompt: 'Address to bind to', validateInput: validateHost, value: 'localhost' });
    return [parseInt(port), addr];
}

export async function promptPortForwarding(config: FileSystemConfig): Promise<PortForwarding | undefined> {
    // TODO: RemoteForward allows omitting the local address/port, making it act as a reverse DynamicForward instead
    // TODO: Make use of config with future GatewayPorts fields and such to suggest default values
    const type = await promptQuickPick<PortForwarding['type']>('Select type of port forwarding', ['local', 'remote', 'dynamic'], capitalize);
    if (!type) return undefined;
    if (type === 'local' || type === 'remote') {
        const local = await promptAddressOrPath('local');
        if (!local) return undefined;
        const remote = await promptAddressOrPath('remote');
        if (!remote) return undefined;
        const [localPort, localAddress] = local;
        const [remotePort, remoteAddress] = remote
        return { type, localAddress, localPort, remoteAddress, remotePort };
    } else if (type === 'dynamic') {
        const bind = await promptBindAddress();
        if (!bind) return undefined;
        const [port, address] = bind;
        return { type: 'dynamic', port, address };
    }
    return undefined;
}
