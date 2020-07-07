import { Client, ClientChannel, PseudoTtyOptions } from "ssh2";
import { Readable } from "stream";
import * as vscode from "vscode";
import { FileSystemConfig } from "./fileSystemConfig";
import { toPromise } from "./toPromise";

const [HEIGHT, WIDTH] = [480, 640];
const PSEUDO_TY_OPTIONS: PseudoTtyOptions = {
    height: HEIGHT, width: WIDTH,
};

export interface SSHPseudoTerminal extends vscode.Pseudoterminal {
    onDidClose: vscode.Event<number>; // Redeclaring that it isn't undefined
    config: FileSystemConfig;
    client: Client;
    channel: ClientChannel;
}

export async function createTerminal(client: Client, config: FileSystemConfig): Promise<SSHPseudoTerminal> {
    const channel = await toPromise<ClientChannel | undefined>(cb => client.shell(PSEUDO_TY_OPTIONS, cb));
    if (!channel) throw new Error('Could not create remote terminal');
    const onDidWrite = new vscode.EventEmitter<string>();
    onDidWrite.fire(`Connecting to ${config.label || config.name}...\n`);
    (channel as Readable).on('data', chunk => onDidWrite.fire(chunk.toString()));
    const onDidClose = new vscode.EventEmitter<number>();
    channel.on('exit', onDidClose.fire);
    // Hopefully the exit event fires first
    channel.on('close', () => onDidClose.fire(1));
    const pseudo: SSHPseudoTerminal = {
        config, client, channel,
        onDidWrite: onDidWrite.event,
        onDidClose: onDidClose.event,
        close() {
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
