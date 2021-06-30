import * as path from 'path';
import type { ClientChannel, PseudoTtyOptions } from "ssh2";
import type { Readable } from "stream";
import * as vscode from "vscode";
import { getFlagBoolean } from './config';
import { Connection, environmentToExportString, joinCommands, mergeEnvironment } from './connection';
import type { EnvironmentVariable, FileSystemConfig } from "./fileSystemConfig";
import { Logging, LOGGING_NO_STACKTRACE } from "./logging";
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
    connection: Connection;
    /** Could be undefined if it only gets created during psy.open() instead of beforehand */
    channel?: ClientChannel;
    /** Either set by the code calling createTerminal, otherwise "calculated" and hopefully found */
    terminal?: vscode.Terminal;
}

export function isSSHPseudoTerminal(terminal: vscode.Pseudoterminal): terminal is SSHPseudoTerminal {
    const term = terminal as SSHPseudoTerminal;
    return !!(term.connection && term.status && term.handleInput);
}

export interface TerminalOptions {
    connection: Connection;
    environment?: EnvironmentVariable[];
    /** If absent, this defaults to config.root if present, otherwise whatever the remote shell picks as default */
    workingDirectory?: string;
    /** The command to run in the remote shell. If undefined, a (regular interactive) shell is started instead by running $SHELL*/
    command?: string;
}

export function replaceVariables(value: string, config: FileSystemConfig): string {
    return value.replace(/\$\{(.*?)\}/g, (str, match: string) => {
        if (!match.startsWith('remote')) return str; // Our variables always start with "remote"
        // https://github.com/microsoft/vscode/blob/bebd06640734c37f6d5f1a82b13297ce1d297dd1/src/vs/workbench/services/configurationResolver/common/variableResolver.ts#L156
        const [key, argument] = match.split(':') as [string, string?];
        const getFilePath = (): vscode.Uri => {
            const uri = vscode.window.activeTextEditor?.document?.uri;
            if (uri && uri.scheme === 'ssh') return uri;
            if (uri) throw new Error(`Variable ${str}: Active editor is not a ssh:// file`);
            throw new Error(`Variable ${str} can not be resolved. Please open an editor.`);
        }
        const getFolderPathForFile = (): vscode.Uri => {
            const filePath = getFilePath();
            const uri = vscode.workspace.getWorkspaceFolder(filePath)?.uri;
            if (uri) return uri;
            throw new Error(`Variable ${str}: can not find workspace folder of '${filePath}'.`);
        }
        const { workspaceFolders = [] } = vscode.workspace;
        const sshFolders = workspaceFolders.filter(ws => ws.uri.scheme === 'ssh');
        const sshFolder = sshFolders.length === 1 ? sshFolders[0] : undefined;
        const getFolderUri = (): vscode.Uri => {
            const { workspaceFolders = [] } = vscode.workspace;
            if (argument) {
                const uri = workspaceFolders.find(ws => ws.name === argument)?.uri;
                if (uri && uri.scheme === 'ssh') return uri;
                if (uri) throw new Error(`Variable ${str}: Workspace folder '${argument}' is not a ssh:// folder`);
                throw new Error(`Variable ${str} can not be resolved. No such folder '${argument}'.`);
            }
            if (sshFolder) return sshFolder.uri;
            if (sshFolders.length > 1) {
                throw new Error(`Variable ${str} can not be resolved in a multi ssh:// folder workspace. Scope this variable using ':' and a workspace folder name.`);
            }
            throw new Error(`Variable ${str} can not be resolved. Please open an ssh:// folder.`);
        };
        switch (key) {
            case 'remoteWorkspaceRoot':
            case 'remoteWorkspaceFolder':
                return getFolderUri().path;
            case 'remoteWorkspaceRootFolderName':
            case 'remoteWorkspaceFolderBasename':
                return path.basename(getFolderUri().path);
            case 'remoteFile':
                return getFilePath().path;
            case 'remoteFileWorkspaceFolder':
                return getFolderPathForFile().path;
            case 'remoteRelativeFile':
                if (sshFolder || argument)
                    return path.relative(getFolderUri().path, getFilePath().path);
                return getFilePath().path;
            case 'remoteRelativeFileDirname': {
                const dirname = path.dirname(getFilePath().path);
                if (sshFolder || argument) {
                    const relative = path.relative(getFolderUri().path, dirname);
                    return relative.length === 0 ? '.' : relative;
                }
                return dirname;
            }
            case 'remoteFileDirname':
                return path.dirname(getFilePath().path);
            case 'remoteFileExtname':
                return path.extname(getFilePath().path);
            case 'remoteFileBasename':
                return path.basename(getFilePath().path);
            case 'remoteFileBasenameNoExtension': {
                const basename = path.basename(getFilePath().path);
                return (basename.slice(0, basename.length - path.extname(basename).length));
            }
            case 'remoteFileDirnameBasename':
                return path.basename(path.dirname(getFilePath().path));
            case 'remotePathSeparator':
                // Not sure if we even need/want this variable, but sure
                return path.posix.sep;
            default:
                const msg = `Unrecognized task variable '${str}' starting with 'remote', ignoring`;
                Logging.warning(msg, LOGGING_NO_STACKTRACE);
                vscode.window.showWarningMessage(msg);
                return str;
        }
    });
}

export async function replaceVariablesRecursive<T>(object: T, handler: (value: string) => string | Promise<string>): Promise<T> {
    if (typeof object === 'string') return handler(object) as any;
    if (Array.isArray(object)) return object.map(v => this.replaceVariablesRecursive(v, handler)) as any;
    if (typeof object == 'object' && object !== null && !(object instanceof RegExp) && !(object instanceof Date)) {
        // ^ Same requirements VS Code applies: https://github.com/microsoft/vscode/blob/bebd06640734c37f6d5f1a82b13297ce1d297dd1/src/vs/base/common/types.ts#L34
        const result: any = {};
        for (let key in object) {
            const value = await replaceVariablesRecursive(object[key], handler);
            key = await replaceVariablesRecursive(key, handler);
            result[key] = value;
        }
        return result;
    }
    return object;
}

export async function createTerminal(options: TerminalOptions): Promise<SSHPseudoTerminal> {
    const { connection } = options;
    const { actualConfig, client } = connection;
    const onDidWrite = new vscode.EventEmitter<string>();
    const onDidClose = new vscode.EventEmitter<number>();
    const onDidOpen = new vscode.EventEmitter<void>();
    let terminal: vscode.Terminal | undefined;
    // Won't actually open the remote terminal until pseudo.open(dims) is called
    const pseudo: SSHPseudoTerminal = {
        status: 'opening',
        connection,
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
            onDidWrite.fire(`Connecting to ${actualConfig.label || actualConfig.name}...\r\n`);
            try {
                const [useWinCmdSep] = getFlagBoolean('WINDOWS_COMMAND_SEPARATOR', false, actualConfig.flags);
                const separator = useWinCmdSep ? ' && ' : '; ';
                let commands: string[] = [];
                let SHELL = '$SHELL';
                // Add exports for environment variables if needed
                const env = mergeEnvironment(connection.environment, options.environment);
                commands.push(environmentToExportString(env));
                // Beta feature to add a "code <file>" command in terminals to open the file locally
                if (getFlagBoolean('REMOTE_COMMANDS', false, actualConfig.flags)[0]) {
                    // For bash
                    commands.push(`export ORIG_PROMPT_COMMAND="$PROMPT_COMMAND"`);
                    commands.push(`export PROMPT_COMMAND='source /tmp/.Kelvin_sshfs PC; $ORIG_PROMPT_COMMAND'`);
                    // For sh
                    commands.push(`export OLD_ENV="$ENV"`); // not actually used (yet?)
                    commands.push(`export ENV=/tmp/.Kelvin_sshfs`);
                }
                // Push the actual command or (default) shell command with replaced variables
                if (options.command) {
                    commands.push(replaceVariables(options.command.replace(/$SHELL/g, SHELL), actualConfig));
                } else {
                    const tc = joinCommands(actualConfig.terminalCommand, separator);
                    let cmd = tc ? replaceVariables(tc.replace(/$SHELL/g, SHELL), actualConfig) : SHELL;
                    commands.push(cmd);
                }
                // There isn't a proper way of setting the working directory, but this should work in most cases
                let { workingDirectory } = options;
                workingDirectory = workingDirectory || actualConfig.root;
                if (workingDirectory) {
                    // TODO: Maybe replace with `connection.home`?
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
                const channel = await toPromise<ClientChannel | undefined>(cb => client.exec(joinCommands(commands, separator)!, { pty: pseudoTtyOptions }, cb));
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
