import type { Client, ClientChannel, PseudoTtyOptions } from "ssh2";
import type { Readable } from "stream";
import * as vscode from "vscode";
import type { FileSystemConfig } from "./fileSystemConfig";
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
    /** Either set by the code calling createTerminal, otherwise "calculated" and hopefully found */
    terminal?: vscode.Terminal;
}

export function isSSHPseudoTerminal(terminal: vscode.Pseudoterminal): terminal is SSHPseudoTerminal {
    const term = terminal as SSHPseudoTerminal;
    return !!(term.config && term.status && term.client);
}

export interface TerminalOptions {
    client: Client;
    config: FileSystemConfig;
    /** If absent, this defaults to config.root if present, otherwise whatever the remote shell picks as default */
    workingDirectory?: string;
    /** The command to run in the remote shell. If undefined, a (regular interactive) shell is started instead by running $SHELL*/
    command?: string;
}

export function joinCommands(commands?: string | string[]): string | undefined {
    if (!commands) return undefined;
    if (typeof commands === 'string') return commands;
    return commands.join('; ');
}

export async function createTerminal(options: TerminalOptions): Promise<SSHPseudoTerminal> {
    const { client, config } = options;
    const onDidWrite = new vscode.EventEmitter<string>();
    const onDidClose = new vscode.EventEmitter<number>();
    const onDidOpen = new vscode.EventEmitter<void>();
    let terminal: vscode.Terminal | undefined;
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
            onDidWrite.fire(`Connecting to ${config.label || config.name}...\r\n`);
            try {
                let commands: string[] = [options.command || joinCommands(options.config.terminalCommand) || '$SHELL'];
                // There isn't a proper way of setting the working directory, but this should work in most cases
                let { workingDirectory } = options;
                workingDirectory = workingDirectory || config.root;
                if (workingDirectory) {
                    if (workingDirectory.startsWith('~')) {
                        // So `cd "~/a/b/..." apparently doesn't work, but `~/"a/b/..."` does
                        // `"~"` would also fail but `~/""` works fine it seems
                        workingDirectory = `~/"${workingDirectory.substr(2)}"`;
                    } else {
                        workingDirectory = `"${workingDirectory}"`;
                    }
                    commands.unshift(`cd ${workingDirectory}`);
                }
                const pseudoTtyOptions: PseudoTtyOptions = { ...PSEUDO_TTY_OPTIONS, cols: dims?.columns, rows: dims?.rows };
                const channel = await toPromise<ClientChannel | undefined>(cb => client.exec(joinCommands(commands)!, { pty: pseudoTtyOptions }, cb));
                if (!channel) throw new Error('Could not create remote terminal');
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
        get terminal(): vscode.Terminal | undefined {
            return terminal ||= vscode.window.terminals.find(t => 'pty' in t.creationOptions && t.creationOptions.pty === pseudo);
        },
        set terminal(term: vscode.Terminal | undefined) {
            terminal = term;
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

export interface TextTerminal extends vscode.Pseudoterminal {
    write(text: string): void;
    close(code?: number): void;
    onDidClose: vscode.Event<number>; // Redeclaring that it isn't undefined
    onDidOpen: vscode.Event<void>;
}

export function createTextTerminal(initialText?: string): TextTerminal {
    const onDidWrite = new vscode.EventEmitter<string>();
    const onDidClose = new vscode.EventEmitter<number>();
    const onDidOpen = new vscode.EventEmitter<void>();
    return {
        write: onDidWrite.fire.bind(onDidWrite),
        close: onDidClose.fire.bind(onDidClose),
        onDidWrite: onDidWrite.event,
        onDidClose: onDidClose.event,
        onDidOpen: onDidOpen.event,
        open: () => initialText && (onDidWrite.fire(initialText + '\r\n'), onDidClose.fire(1)),
    };
}
