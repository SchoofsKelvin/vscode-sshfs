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
    onDidOpen: vscode.Event<void>;
    handleInput(data: string): void; // We don't support/need read-only terminals for now
    status: 'opening' | 'open' | 'closed';
    config: FileSystemConfig;
    client: Client;
    /** Could be undefined if it only gets created during psy.open() instead of beforehand */
    channel?: ClientChannel;
}

export interface TerminalOptions {
    client: Client;
    config: FileSystemConfig;
    workingDirectory?: string;
    /** The command to run in the remote shell. If undefined, a (regular interactive) shell is started instead */
    command?: string;
}

export async function createTerminal(options: TerminalOptions): Promise<SSHPseudoTerminal> {
    const { client, config, command } = options;
    const onDidWrite = new vscode.EventEmitter<string>();
    const onDidClose = new vscode.EventEmitter<number>();
    const onDidOpen = new vscode.EventEmitter<void>();
    // Won't actually open the remote terminal until pseudo.open(dims) is called
    const pseudo: SSHPseudoTerminal = {
        status: 'opening',
        config, client,
        onDidWrite: onDidWrite.event,
        onDidClose: onDidClose.event,
        onDidOpen: onDidOpen.event,
        close() {
            const { channel } = pseudo;
            if (!channel) return;
            pseudo.status = 'closed';
            channel.signal('INT');
            channel.signal('SIGINT');
            channel.write('\x03');
            channel.close();
            pseudo.channel = undefined;
        },
        async open(dims) {
            console.log('Called pseudo.open');
            onDidWrite.fire(`Connecting to ${config.label || config.name}...\r\n`);
            try {
                let setupCommand: string | undefined;
                // There isn't a proper way of setting the working directory, but this should work in most cases
                let { workingDirectory } = options;
                if (workingDirectory) {
                    if (workingDirectory.startsWith('~')) {
                        // So `cd "~/a/b/..." apparently doesn't work, but `~/"a/b/..."` does
                        // `"~"` would also fail but `~/""` works fine it seems
                        workingDirectory = `~/"${workingDirectory.substr(2)}"`;
                    } else {
                        workingDirectory = `"${workingDirectory}"`;
                    }
                    setupCommand = `cd ${workingDirectory}`;
                }
                const pseudoTtyOptions: PseudoTtyOptions = { ...PSEUDO_TTY_OPTIONS, cols: dims?.columns, rows: dims?.rows };
                const channel = await toPromise<ClientChannel | undefined>(cb => command ?
                    client.exec(setupCommand ? `${setupCommand}; ${command}` : command, { pty: pseudoTtyOptions }, cb) :
                    client.shell(pseudoTtyOptions, cb));
                if (!channel) throw new Error('Could not create remote terminal');
                if (!command && setupCommand) channel.write(setupCommand + '\n');
                pseudo.channel = channel;
                channel.on('exit', onDidClose.fire);
                channel.on('close', () => onDidClose.fire(0));
                (channel as Readable).on('data', chunk => onDidWrite.fire(chunk.toString()));
                // TODO: Keep track of stdout's color, switch to red, output, then switch back?
                channel.stderr.on('data', chunk => onDidWrite.fire(chunk.toString()));
                // Inform others (e.g. createTaskTerminal) that the terminal is ready to be used
                pseudo.status = 'open';
                onDidOpen.fire();
            } catch (e) {
                onDidWrite.fire(`Error starting SSH terminal:\r\n${e}\r\n`);
                onDidClose.fire(1);
                pseudo.status = 'closed';
                pseudo.channel?.destroy();
            }
        },
        setDimensions(dims) {
            pseudo.channel?.setWindow(dims.rows, dims.columns, HEIGHT, WIDTH);
        },
        handleInput(data) {
            pseudo.channel?.write(data);
        },
    };
    return pseudo;
}
