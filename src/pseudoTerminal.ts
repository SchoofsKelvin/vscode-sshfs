import { Client, ClientChannel, PseudoTtyOptions } from "ssh2";
import { Readable } from "stream";
import * as vscode from "vscode";
import { FileSystemConfig } from "./fileSystemConfig";
import { toPromise } from "./toPromise";

const [HEIGHT, WIDTH] = [480, 640];
const PSEUDO_TTY_OPTIONS: PseudoTtyOptions = {
    height: HEIGHT, width: WIDTH,
};

export interface SSHPseudoTerminal extends vscode.Pseudoterminal {
    onDidClose: vscode.Event<number>; // Redeclaring that it isn't undefined
    config: FileSystemConfig;
    client: Client;
    /** Could be undefined if it only gets created during psy.open() instead of beforehand */
    channel?: ClientChannel;
}

export async function createTerminal(client: Client, config: FileSystemConfig): Promise<SSHPseudoTerminal> {
    const channel = await toPromise<ClientChannel | undefined>(cb => client.shell(PSEUDO_TTY_OPTIONS, cb));
    if (!channel) throw new Error('Could not create remote terminal');
    const onDidWrite = new vscode.EventEmitter<string>();
    onDidWrite.fire(`Connecting to ${config.label || config.name}...\n`);
    (channel as Readable).on('data', chunk => onDidWrite.fire(chunk.toString()));
    channel.stderr.on('data', chunk => onDidWrite.fire(chunk.toString()));
    const onDidClose = new vscode.EventEmitter<number>();
    channel.on('exit', onDidClose.fire);
    // Hopefully the exit event fires first
    channel.on('close', () => onDidClose.fire(0));
    const pseudo: SSHPseudoTerminal = {
        config, client, channel,
        onDidWrite: onDidWrite.event,
        onDidClose: onDidClose.event,
        close() {
            channel.signal('INT');
            channel.signal('SIGINT');
            channel.write('\x03');
            channel.close();
        },
        open(dims) {
            if (!dims) return;
            channel.setWindow(dims.rows, dims.columns, HEIGHT, WIDTH);
        },
        setDimensions(dims) {
            channel.setWindow(dims.rows, dims.columns, HEIGHT, WIDTH);
        },
        handleInput(data) {
            channel.write(data);
        },
    };
    return pseudo;
}

export interface TaskTerminalOptions {
    client: Client;
    config: FileSystemConfig;
    command: string;
}

export async function createTaskTerminal(options: TaskTerminalOptions): Promise<SSHPseudoTerminal> {
    const { client, config, command } = options;
    const onDidWrite = new vscode.EventEmitter<string>();
    onDidWrite.fire(`Connecting to ${config.label || config.name}...\n`);
    const onDidClose = new vscode.EventEmitter<number>();
    let channel: ClientChannel;
    const pseudo: SSHPseudoTerminal = {
        config, client,
        onDidWrite: onDidWrite.event,
        onDidClose: onDidClose.event,
        close() {
            channel?.signal('INT');
            channel?.signal('SIGINT');
            channel?.write('\x03');
            channel?.close();
        },
        open(dims) {
            onDidWrite.fire(`Running command: ${command}\n`);
            (async () => {
                const ch = await toPromise<ClientChannel | undefined>(cb => client.exec(command, {
                    pty: { ...PSEUDO_TTY_OPTIONS, cols: dims?.columns, rows: dims?.rows }
                }, cb));
                if (!ch) {
                    onDidWrite.fire(`Could not create SSH channel, running task failed\n`);
                    onDidClose.fire(1);
                    return;
                }
                pseudo.channel = channel = ch;
                channel.on('exit', onDidClose.fire);
                channel.on('close', () => onDidClose.fire(0));
                (channel as Readable).on('data', chunk => onDidWrite.fire(chunk.toString()));
                channel.stderr.on('data', chunk => onDidWrite.fire(chunk.toString()));
            })().catch(e => {
                onDidWrite.fire(`Error starting process over SSH:\n${e}\n`);
                onDidClose.fire(1);
            });
        },
        setDimensions(dims) {
            channel?.setWindow(dims.rows, dims.columns, HEIGHT, WIDTH);
        },
        handleInput(data) {
            channel?.write(data);
        },
    };
    return pseudo;
}
