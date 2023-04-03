import type { FileSystemConfig } from 'common/fileSystemConfig';
import { getIP } from 'ip-matching';
import * as net from 'net';
import type { ClientChannel, TcpConnectionDetails, UnixConnectionDetails } from 'ssh2';
import type { Duplex } from 'stream';
import * as vscode from 'vscode';
import type { Connection } from "./connection";
import { LOGGING_NO_STACKTRACE, Logging } from './logging';
import type { Manager } from './manager';
import { FormattedItem, promptQuickPick } from './ui-utils';
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

function tryParseInt(input?: string): number | undefined {
    const parsed = input ? parseInt(input) : undefined;
    return Number.isNaN(parsed) ? undefined : parsed;
}

// https://regexr.com/61quq
const PORT_FORWARD_REGEX = /^(?<type>\w+)\s*?(?:(?:\s+(?:(?<localAddress>[^\s:]+|[\da-zA-Z:]+|\[[\da-zA-Z:]+\]):))?(?<localPort>\d+)|(?<localPath>[/\\][/\\.\w?\-]+))(?:\s+(?:(?<remoteAddress>[^\s:]+|[\da-zA-Z:]+|\[[\da-zA-Z:]+\]):)?(?<remotePort>\d+)|\s+(?<remotePath>[/\\][/\\.\w?\-]+))?$/i;
const PORT_FORWARD_TYPES = ['remote', 'local', 'dynamic'];
export function parsePortForwarding(input: string, mode: 'throw'): PortForwarding;
export function parsePortForwarding(input: string, mode: 'report' | 'ignore'): PortForwarding | undefined;
export function parsePortForwarding(input: string, mode: 'report' | 'throw' | 'ignore'): PortForwarding | undefined {
    try {
        const match = input.match(PORT_FORWARD_REGEX);
        if (!match) throw new Error(`Could not infer PortForwarding from '${input}'`);
        let type = match.groups?.type.toLowerCase();
        if (!type) throw new Error(`Could not infer PortForwarding from '${input}'`);
        if (type.endsWith('forward')) type = type.substring(0, type.length - 7);
        if (type.length === 1) type = PORT_FORWARD_TYPES.find(t => t[0] === type);
        if (!type || !PORT_FORWARD_TYPES.includes(type))
            throw new Error(`Could not recognize PortForwarding type '${match.groups!.type}'`);
        let {
            localPath, localAddress = localPath, localPort,
            remotePath, remoteAddress = remotePath, remotePort,
        } = match.groups as Partial<Record<string, string>>;
        if (localAddress?.[0] === '[' && localAddress.endsWith(']'))
            localAddress = localAddress.substring(1, localAddress.length - 1);
        if (remoteAddress?.[0] === '[' && remoteAddress.endsWith(']'))
            remoteAddress = remoteAddress.substring(1, remoteAddress.length - 1);
        let pf: PortForwarding;
        if (type === 'remote' && !remoteAddress && !remotePort) {
            pf = { type, remoteAddress: localAddress, remotePort: tryParseInt(localPort) };
        } else if (type === 'local' || type === 'remote') {
            pf = {
                type,
                localAddress, localPort: tryParseInt(localPort),
                remoteAddress, remotePort: tryParseInt(remotePort),
            };
        } else {
            pf = { type: 'dynamic', address: localAddress, port: tryParseInt(localPort)! };
        }
        validatePortForwarding(pf);
        return pf;
    } catch (e) {
        if (mode === 'ignore') return undefined;
        if (mode === 'throw') throw e;
        Logging.error(`Parsing port forwarding '${input}' failed:\n${e.message || e}`, LOGGING_NO_STACKTRACE);
        return undefined;
    }
}

export function getPortForwardingIcon(forwarding: PortForwarding): string {
    if (forwarding.type === 'dynamic') return 'globe';
    if (forwarding.type === 'local') return 'arrow-small-left';
    if (!forwarding.localAddress && forwarding.localPort === undefined) return 'globe';
    return 'arrow-small-right';
}

const SINGLE_WORD_PATH_REGEX = /^[/\\.\w?]+$/;
const formatAddrPortPath = (addr?: string, port?: number): string => {
    if (port === undefined) {
        if (!addr) return 'N/A';
        if (SINGLE_WORD_PATH_REGEX.test(addr)) return addr;
        return `'${addr}'`;
    }
    if (addr) try {
        const ip = getIP(addr);
        if (ip?.type === 'IPv6') return `[${addr.toString()}]:${port}`;
    } catch (e) { }
    return `${addr || '*'}:${port}`;
};
export function formatPortForwarding(forwarding: PortForwarding): string {
    if (forwarding.type === 'local' || forwarding.type === 'remote') {
        const local = (forwarding.localPort !== undefined || forwarding.localAddress)
            ? formatAddrPortPath(forwarding.localAddress, forwarding.localPort) : 'SOCKSv5';
        return `${local} ${forwarding.type === 'local' ? ' → ' : ' ← '} ${formatAddrPortPath(forwarding.remoteAddress, forwarding.remotePort)}`;
    } else if (forwarding.type === 'dynamic') {
        return `${formatAddrPortPath(forwarding.address, forwarding.port)} → SOCKSv5`;
    }
    // Shouldn't happen but might as well catch it this way
    return JSON.stringify(forwarding);
}
export function formatPortForwardingConfig(forwarding: PortForwarding): string {
    if (forwarding.type === 'local') {
        const { localAddress, localPort, remoteAddress, remotePort } = forwarding;
        return `LocalForward ${formatAddrPortPath(localAddress, localPort)} ${formatAddrPortPath(remoteAddress, remotePort)}`;
    } else if (forwarding.type === 'remote') {
        const { localAddress, localPort, remoteAddress, remotePort } = forwarding;
        if (!localAddress && localPort === undefined) {
            return `RemoteForward ${formatAddrPortPath(remoteAddress, remotePort)}`;
        }
        return `RemoteForward ${formatAddrPortPath(localAddress, localPort)} ${formatAddrPortPath(remoteAddress, remotePort)}`;
    } else if (forwarding.type === 'dynamic') {
        return `DynamicForward ${formatAddrPortPath(forwarding.address, forwarding.port)}`;
    }
    throw new Error(`Unrecognized forwarding type '${forwarding.type}'`);
}

type Disconnect = () => void;
export type ActivePortForwarding = [data: PortForwarding, connection: Connection, disconnect: Disconnect];
export function isActivePortForwarding(apf: any): apf is ActivePortForwarding {
    return Array.isArray(apf) && apf.length === 3 && 'type' in apf[0];
}

function validateLocalRemoteForwarding(forwarding: PortForwardingLocalRemote) {
    if (forwarding.type === 'local') {
        // Requires `localAddress:localPort` or `localAddress` or `localPort`
        if (!forwarding.localAddress && forwarding.localPort === undefined)
            throw new Error(`Expected 'localAddress' and/or 'localPort' fields for LocalForward`);
        // Requires `remoteAddress:remotePort` or `remoteAddress`
        if (!forwarding.remoteAddress)
            throw new Error(`Expected 'remoteAddress' field for LocalForward`);
    } else if (forwarding.type === 'remote') {
        // Requires `remoteAddress:remotePort` or `remoteAddress` or `remotePort`
        if (!forwarding.remoteAddress && forwarding.remotePort === undefined)
            throw new Error(`Expected 'remoteAddress' and/or 'remotePort' fields for RemoteForward`);
        if (forwarding.localAddress || forwarding.localPort !== undefined) {
            // Regular forward, so validate the local stuff
            // Requires `localAddress:localPort` or `localAddress`
            if (!forwarding.localAddress)
                throw new Error(`Expected 'localAddress' field for RemoteForward`);
        }
    }
    // Validate ports if given
    if (forwarding.localPort !== undefined) {
        if (!Number.isInteger(forwarding.localPort) || forwarding.localPort < 0 || forwarding.localPort > 65565)
            throw new Error(`Expected 'localPort' field to be an integer 0-65565 for RemoteForward`);
    }
    if (forwarding.remotePort !== undefined) {
        if (!Number.isInteger(forwarding.remotePort) || forwarding.remotePort < 0 || forwarding.remotePort > 65565)
            throw new Error(`Expected 'remotePort' field to be an integer 0-65565 for RemoteForward`);
    }
}

function validateDynamicForwarding(forwarding: PortForwardingDynamic) {
    // Requires `address:port` (or only `address` if we allowed Unix socket paths, but OpenSSH doesn't and neither do we)
    if (!forwarding.address)
        throw new Error(`Missing 'address' field for DynamicForward`);
    if (forwarding.port === undefined)
        throw new Error(`Missing 'port' field for DynamicForward`);
    if (!Number.isInteger(forwarding.port) || forwarding.port < 0 || forwarding.port > 65565) {
        throw new Error(`Expected 'port' field to be an integer 0-65565 for DynamicForward`);
    }
}

export function validatePortForwarding(forwarding: PortForwarding): PortForwarding {
    switch (forwarding.type) {
        case 'dynamic':
            validateDynamicForwarding(forwarding);
            return forwarding;
        case 'local':
        case 'remote':
            validateLocalRemoteForwarding(forwarding);
            return forwarding;
        default:
            throw new Error(`Unknown PortForwarding type '${(forwarding as any).type}'`);
    }
}

async function createLocalForwarding(connection: Connection, forwarding: PortForwardingLocalRemote): Promise<ActivePortForwarding> {
    validateLocalRemoteForwarding(forwarding);
    if (forwarding.localAddress === '') forwarding = { ...forwarding, localAddress: undefined };
    if (forwarding.localAddress === '*') forwarding = { ...forwarding, localAddress: undefined };
    const { localAddress, localPort, remoteAddress, remotePort } = forwarding;
    const logging = Logging.scope(formatPortForwarding(forwarding));
    logging.info(`Setting up local forwarding`);
    const { client } = connection;
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        if (remotePort === undefined) {
            client.openssh_forwardOutStreamLocal(remoteAddress!, (err, channel) => {
                if (err) return socket.destroy(err);
                socket.pipe(channel).pipe(socket);
            });
        } else {
            client.forwardOut('localhost', 0, remoteAddress || '', remotePort, (err, channel) => {
                if (err) return socket.destroy(err);
                socket.pipe(channel).pipe(socket);
            });
        }
    });
    if (localPort === undefined) {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(localAddress, resolve);
        });
        logging.info(`Listening on local socket path: ${localAddress}`);
    } else {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            if (localAddress) server.listen(localPort, localAddress, resolve)
            else server.listen(localPort, resolve);
        });
        if (localPort === 0) {
            forwarding = { ...forwarding, localPort: (server.address() as net.AddressInfo).port };
        }
        logging.info(`Listening on remote port ${remoteAddress || '*'}:${localPort}`);
    }
    return [forwarding, connection, () => server.close(() => sockets.forEach(s => s.destroy()))];
}

async function createRemoteForwarding(connection: Connection, forwarding: PortForwardingLocalRemote): Promise<ActivePortForwarding> {
    validateLocalRemoteForwarding(forwarding);
    const { localAddress, localPort, remoteAddress, remotePort } = forwarding;
    const logging = Logging.scope(formatPortForwarding(forwarding));
    let socksServer: import('node-socksv5').Server | undefined;
    if (localPort === undefined && !localPort) {
        logging.info(`Setting up remote SOCKSv5 proxy with no authentication`);
        const { Server, Auth } = await import('node-socksv5');
        socksServer = new Server({ auths: [Auth.none()] });
    } else {
        logging.info(`Setting up remote port forwarding for local address ${localAddress || '*'}:${localPort}`);
    }
    const channels = new Set<Duplex>();
    const onSocket = (channel: Duplex) => {
        channels.add(channel);
        channel.on('close', () => channels.delete(channel));
        let socket: net.Socket;
        if (socksServer) {
            socket = new net.Socket();
            ((socksServer as any).onConnection as (typeof socksServer)['onConnection'])(channel as net.Socket);
        } else if (localPort === undefined) {
            socket = net.createConnection(localAddress!);
            socket.on('connect', () => socket.pipe(channel).pipe(socket));
        } else {
            socket = net.createConnection(localPort, localAddress!);
            socket.on('connect', () => socket.pipe(channel).pipe(socket));
        }
    };
    let unlisten: () => void;
    if (remotePort === undefined) {
        await toPromise(cb => connection.client.openssh_forwardInStreamLocal(remoteAddress!, cb));
        const listener = (details: UnixConnectionDetails, accept: () => ClientChannel) => {
            if (details.socketPath !== remoteAddress) return;
            onSocket(accept());
        };
        connection.client.on('unix connection', listener);
        unlisten = () => connection.client.off('unix connection', listener);
        logging.info(`Listening on remote socket path: ${remoteAddress}`);
    } else {
        const rAddr = remoteAddress === '*' ? '' : remoteAddress || '';
        const actualPort = await toPromise<number>(cb => connection.client.forwardIn(rAddr, remotePort!, cb));
        forwarding = { ...forwarding, remotePort: actualPort };
        const listener = (details: TcpConnectionDetails, accept: () => ClientChannel) => {
            if (details.destPort !== actualPort) return;
            if (details.destIP !== rAddr) return;
            onSocket(accept());
        };
        connection.client.on('tcp connection', listener);
        unlisten = () => connection.client.off('tcp connection', listener);
        logging.info(`Listening on remote port ${remoteAddress || '*'}:${actualPort}`);
    }
    return [forwarding, connection, () => {
        unlisten();
        if (socksServer) ((socksServer as any).serverSocket as net.Server).close();
        try {
            if (forwarding.remotePort === undefined) {
                connection.client.openssh_unforwardInStreamLocal(forwarding.remoteAddress!);
            } else {
                connection.client.unforwardIn(forwarding.remoteAddress!, forwarding.remotePort!);
            }
        } catch (e) {
            // Unforwarding when the client is already disconnected throw an error
        }
        channels.forEach(s => s.destroy());
    }];
}

async function createDynamicForwarding(connection: Connection, forwarding: PortForwardingDynamic): Promise<ActivePortForwarding> {
    validateDynamicForwarding(forwarding);
    // Default is localhost, so transform `undefined` to 'localhost'
    if (!forwarding.address) forwarding = { ...forwarding, address: 'localhost' };
    // But `undefined` in the net API means "any interface", so transform '*' into `undefined`
    if (forwarding.address === '*') forwarding = { ...forwarding, address: undefined };
    const logging = Logging.scope(formatPortForwarding(forwarding));
    logging.info(`Setting up dynamic forwarding on ${forwarding.address || '*'}:${forwarding.port}`);
    const channels = new Set<Duplex>();
    let closed = false;
    const { Server, Command, Auth } = await import('node-socksv5');
    const server = new Server({ auths: [Auth.none()] }, async (info, accept, deny) => {
        if (closed) return deny();
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
    const processConnection: (typeof server)['processConnection'] = async function (this: typeof server, socket, destination) {
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
        default: throw new Error(`Forwarding type '${type}' is not recognized`);
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
        if (!ip || !ip.exact()) return 'Invalid IP / domain';
    } catch (e) {
        return e.message || 'Invalid IP / domain';
    }
}
const PIPE_REGEX = /^\\\\[\?\.]\\pipe\\.*$/;
function validatePipe(str: string): string | undefined {
    if (str.match(PIPE_REGEX)) return undefined;
    return 'Windows pipe path should start with \\\\?\\pipe\\ or \\\\.\\pipe\\';
}
function validatePort(str: string, allowRandom: boolean): string | undefined {
    try {
        const port = parseInt(str);
        if (!allowRandom && port === 0) return undefined;
        if (port >= 0 && port < 2 ** 16) return undefined;
        return `Port has to be in the range ${allowRandom ? 0 : 1}-65535`;
    } catch (e) {
        return 'Invalid port';
    }
}
const SOCKET_REGEX = /^[/\\][^\0]+$/;
function validateSocketPath(str: string): string | undefined {
    if (str.match(SOCKET_REGEX)) return undefined;
    return 'Unix domain socket path should be a proper absolute file path';
}
async function promptAddressOrPath(location: 'local' | 'remote', allowWildcard: boolean): Promise<[port?: number, address?: string] | undefined> {
    const A = 'address:port';
    const B = 'socket path / pipe';
    const type = await promptQuickPick(`Use a ${location} address:port or Unix domain socket path / Windows pipe?`, [A, B] as const);
    if (!type) return undefined;
    if (type === A) {
        const placeHolder = allowWildcard ? 'IPv4 / IPv6 / domain / *' : 'IPv4 / IPv6 / domain';
        let validateInput = allowWildcard ? (input: string) => input === '*' ? undefined : validateHost(input) : validateHost;
        const addr = await vscode.window.showInputBox({ prompt: 'Address to use', validateInput, placeHolder });
        validateInput = (input: string) => validatePort(input, allowWildcard);
        const port = await vscode.window.showInputBox({ prompt: 'Port to use', validateInput, placeHolder: `${allowWildcard ? 0 : 1}-65535` });
        return port === undefined ? undefined : [parseInt(port), addr];
    } else if (location === 'local' && process.platform === 'win32') {
        const pipe = await vscode.window.showInputBox({ prompt: 'Pipe to use', validateInput: validatePipe, placeHolder: '\\\\?\\pipe\\...' });
        return pipe ? [, pipe] : undefined;
    } else {
        const path = await vscode.window.showInputBox({ prompt: 'Socket path to use', validateInput: validateSocketPath, placeHolder: '/tmp/socket' });
        return path ? [, path] : undefined;
    }
}

async function promptFullLocalRemoteForwarding(type: 'local' | 'remote'): Promise<PortForwarding | undefined> {
    const local = await promptAddressOrPath('local', type === 'local');
    const remote = local && await promptAddressOrPath('remote', type === 'remote');
    if (!remote) return undefined;
    const [localPort, localAddress] = local;
    const [remotePort, remoteAddress] = remote;
    return { type, localPort, localAddress, remotePort, remoteAddress };
}

async function promptRemoteProxyForwarding(): Promise<PortForwarding | undefined> {
    const remote = await promptAddressOrPath('remote', true);
    if (!remote) return undefined;
    const [remotePort, remoteAddress] = remote;
    return { type: 'remote', remotePort, remoteAddress };
}

async function promptDynamicForwarding(): Promise<PortForwarding | undefined> {
    const local = await promptAddressOrPath('local', true);
    if (!local) return undefined;
    const [port, address] = local;
    return { type: 'dynamic', port: port!, address };
}

export async function promptPortForwarding(config: FileSystemConfig): Promise<PortForwarding | undefined> {
    const picker = vscode.window.createQuickPick<FormattedItem>();
    picker.title = `Port forwarding to ${config.label || config.name}`;
    picker.ignoreFocusOut = true;
    picker.matchOnDetail = true;
    picker.matchOnDescription = true;
    const ITEMS: FormattedItem[] = [
        { item: 'local', label: '→ Local forward' },
        { item: 'remote', label: '← Remote forward' },
        { item: 'remoteProxy', label: '$(globe) Remote proxy (client SOCKSv5 ← server)', description: '(omit local address/port)' },
        { item: 'dynamic', label: '$(globe) Dynamic forward (client → server SOCKSv5)' },
        { item: 'examples', label: '$(list-unordered) Show examples' },
    ];
    const formatPF = (forward: PortForwarding, description?: string, alwaysShow?: boolean): FormattedItem => ({
        item: forward, alwaysShow, description,
        label: `$(${getPortForwardingIcon(forward)}) ${formatPortForwarding(forward)}`,
        detail: formatPortForwardingConfig(forward),
    });
    let examples = false;
    const updateItems = () => {
        let items: FormattedItem[] = [];
        let suggested: FormattedItem[] = [];
        if (picker.value === 'examples' || picker.value.startsWith('examples ')) {
            examples = true;
            picker.value = picker.value.slice(9);
        }
        if (examples) {
            suggested = [{ item: 'return', label: '$(quick-input-back) Return', alwaysShow: true }];
            items = [
                formatPF({ type: 'local', localPort: 0, remoteAddress: 'localhost', remotePort: 8080 }, 'Port 0 will pick a free port'),
                formatPF({ type: 'local', localPort: 8080, remoteAddress: 'localhost', remotePort: 8080 }, 'No address or "*" binds to all interfaces'),
                formatPF({ type: 'local', localAddress: '\\\\?\\pipe\\windows\\named\\pipe', remoteAddress: '/tmp/unix/socket' }, 'Supports Unix sockets'),
                formatPF({ type: 'remote', localPort: 8080, remotePort: 8080 }, 'No address or "*" binds to all interfaces'),
                formatPF({ type: 'remote', localAddress: 'example.com', localPort: 80, remoteAddress: '0::1', remotePort: 8080 }, 'Supports hostnames and IPv6'),
                formatPF({ type: 'remote', remoteAddress: 'localhost', remotePort: 1234 }, 'Bind remotely to proxy through client'),
                formatPF({ type: 'dynamic', address: 'localhost', port: 1234 }, 'Bind locally to proxy through server'),
            ];
        } else if (picker.value) {
            const type = picker.value.toLowerCase().trimLeft().match(/^[a-zA-Z]*/)![0].replace(/Forward$/, '');
            let detail: string;
            if (type === 'l' || type === 'local') {
                detail = 'Local [localAddress]:localPort remoteAddress:remotePort';
            } else if (type === 'r' || type === 'remote') {
                detail = 'Remote [localAddress:localPort] [remoteAddress]:remotePort';
            } else if (type === 'd' || type === 'dynamic') {
                detail = 'Dynamic localAddress:localPort';
            } else {
                detail = 'Select or type a port forwarding type';
                items = [...ITEMS];
            }
            try {
                const forward = parsePortForwarding(picker.value, 'throw');
                suggested.unshift(formatPF(forward, undefined, true));
                detail = `Current syntax: ${detail}`;
            } catch (e) {
                const label = (e.message as string).replace(/from '.*'$/, '');
                items.unshift({ item: undefined, label, detail, alwaysShow: true });
            }
            items.push({ item: 'return', label: '$(quick-input-back) Pick type', detail, alwaysShow: true });
        } else {
            items = ITEMS;
        }
        // If you set items first, onDidAccept will be triggered (even though it shouldn't)
        picker.selectedItems = picker.activeItems = suggested;
        picker.items = items.length ? [...suggested, ...items] : suggested;
    };
    updateItems();
    picker.onDidChangeValue(updateItems);
    return new Promise<PortForwarding | undefined>((resolve) => {
        picker.onDidAccept(() => {
            if (!picker.selectedItems.length) return;
            const [{ item }] = picker.selectedItems;
            if (!item) return;
            if (item === 'examples') {
                examples = true;
                picker.value = '';
            } else if (item === 'return') {
                examples = false;
                picker.value = '';
            } else if (item === 'local' || item === 'remote') {
                return resolve(promptFullLocalRemoteForwarding(item));
            } else if (item === 'remoteProxy') {
                return resolve(promptRemoteProxyForwarding());
            } else if (item === 'dynamic') {
                return resolve(promptDynamicForwarding());
            } else if (examples) {
                // Looking at examples, don't actually accept but copy the value
                examples = false;
                picker.value = formatPortForwardingConfig(item);
            } else {
                return resolve(item);
            }
            updateItems();
        });
        picker.onDidHide(() => resolve(undefined));
        picker.show();
    }).finally(() => picker.dispose());
}
