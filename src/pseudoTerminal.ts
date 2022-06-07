import type { EnvironmentVariable, FileSystemConfig } from 'common/fileSystemConfig';
import * as path from 'path';
import type { ClientChannel, PseudoTtyOptions } from 'ssh2';
import * as vscode from 'vscode';
import { getFlagBoolean } from './flags';
import type { Connection } from './connection';
import { Logging, LOGGING_NO_STACKTRACE } from './logging';
import { environmentToExportString, joinCommands, mergeEnvironment, toPromise } from './utils';

const [HEIGHT, WIDTH] = [480, 640];
const PSEUDO_TTY_OPTIONS: Partial<PseudoTtyOptions> = {
    height: HEIGHT, width: WIDTH, term: 'xterm-256color',
};

export interface SSHPseudoTerminal extends vscode.Pseudoterminal {
    onDidClose: vscode.Event<number>; // Redeclaring that it isn't undefined
    onDidOpen: vscode.Event<void>;
    handleInput(data: string): void; // We don't support/need read-only terminals for now
    status: 'opening' | 'open' | 'closed' | 'wait-to-close';
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
    const { actualConfig, client, shellConfig } = connection;
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
            const { channel, status } = pseudo;
            if (status === 'closed') return;
            if (channel) {
                pseudo.status = 'closed';
                channel.signal!('INT');
                channel.signal!('SIGINT');
                channel.write('\x03');
                channel.close();
                pseudo.channel = undefined;
            }
            if (status === 'wait-to-close') {
                pseudo.terminal?.dispose();
                pseudo.terminal = undefined;
                pseudo.status = 'closed';
                onDidClose.fire(0);
            }
        },
        async open(dims) {
            onDidWrite.fire(`Connecting to ${actualConfig.label || actualConfig.name}...\r\n`);
            try {
                const [useWinCmdSep] = getFlagBoolean('WINDOWS_COMMAND_SEPARATOR', shellConfig.isWindows, actualConfig.flags);
                const separator = useWinCmdSep ? ' && ' : '; ';
                let commands: string[] = [];
                let SHELL = '$SHELL';
                if (shellConfig.isWindows) SHELL = shellConfig.shell;
                // Add exports for environment variables if needed
                const env = mergeEnvironment(connection.environment, options.environment);
                commands.push(environmentToExportString(env, shellConfig.setEnv));
                // Beta feature to add a "code <file>" command in terminals to open the file locally
                if (getFlagBoolean('REMOTE_COMMANDS', false, actualConfig.flags)[0] && shellConfig.setupRemoteCommands) {
                    const rcCmds = await shellConfig.setupRemoteCommands(connection);
                    if (rcCmds?.length) commands.push(joinCommands(rcCmds, separator)!);
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
                let cmd = joinCommands(commands, separator)!;
                if (workingDirectory) {
                    if (cmd.includes('${workingDirectory}')) {
                        cmd = cmd.replace(/\${workingDirectory}/g, workingDirectory);
                    } else {
                        // TODO: Maybe replace with `connection.home`? Especially with Windows not supporting ~
                        if (workingDirectory.startsWith('~')) {
                            if (shellConfig.isWindows)
                                throw new Error(`Working directory '${workingDirectory}' starts with ~ for a Windows shell`);
                            // So `cd "~/a/b/..." apparently doesn't work, but `~/"a/b/..."` does
                            // `"~"` would also fail but `~/""` works fine it seems
                            workingDirectory = `~/"${workingDirectory.slice(2)}"`;
                        } else {
                            if (shellConfig.isWindows && workingDirectory.match(/^\/[a-zA-Z]:/))
                                workingDirectory = workingDirectory.slice(1);
                            workingDirectory = `"${workingDirectory}"`;
                        }
                        cmd = joinCommands([`cd ${workingDirectory}`, ...commands], separator)!;
                    }
                } else {
                    cmd = cmd.replace(/\${workingDirectory}/g, '');
                }
                const pseudoTtyOptions: Partial<PseudoTtyOptions> = { ...PSEUDO_TTY_OPTIONS, cols: dims?.columns, rows: dims?.rows };
                Logging.debug(`Starting shell for ${connection.actualConfig.name}: ${cmd}`);
                const channel = await toPromise<ClientChannel | undefined>(cb => client.exec(cmd, { pty: pseudoTtyOptions }, cb));
                if (!channel) throw new Error('Could not create remote terminal');
                pseudo.channel = channel;
                const startTime = Date.now();
                channel.once('exit', (code, signal, _, description) => {
                    Logging.debug`Terminal session closed: ${{ code, signal, description, status: pseudo.status }}`;
                    if (code && (Date.now() < startTime + 1000) && !options.command) {
                        // Terminal failed within a second, let's keep it open for the user to see the error (if this isn't a task)
                        onDidWrite.fire(`Got error code ${code}${signal ? ` with signal ${signal}` : ''}\r\n`);
                        if (description) onDidWrite.fire(`Extra info: ${description}\r\n`);
                        onDidWrite.fire('Press a key to close the terminal\r\n');
                        onDidWrite.fire('Possible more stdout/stderr below:\r\n');
                        pseudo.status = 'wait-to-close';
                    } else {
                        onDidClose.fire(code || 0);
                        pseudo.status = 'closed';
                    }
                });
                channel.once('readable', () => {
                    // Inform others (e.g. createTaskTerminal) that the terminal is ready to be used
                    if (pseudo.status === 'opening') pseudo.status = 'open';
                    onDidOpen.fire();
                });
                channel.on('data', chunk => onDidWrite.fire(chunk.toString()));
                channel.stderr!.on('data', chunk => onDidWrite.fire(chunk.toString()));
                // TODO: ^ Keep track of stdout's color, switch to red, output, then switch back?
            } catch (e) {
                Logging.error`Error starting SSH terminal:\n${e}`;
                onDidWrite.fire(`Error starting SSH terminal:\r\n${e}\r\n`);
                onDidClose.fire(1);
                pseudo.status = 'closed';
                pseudo.channel?.destroy();
                pseudo.channel = undefined;
            }
        },
        get terminal(): vscode.Terminal | undefined {
            return terminal ||= vscode.window.terminals.find(t => 'pty' in t.creationOptions && t.creationOptions.pty === pseudo);
        },
        set terminal(term: vscode.Terminal | undefined) {
            terminal = term;
        },
        setDimensions(dims) {
            pseudo.channel?.setWindow!(dims.rows, dims.columns, HEIGHT, WIDTH);
        },
        handleInput(data) {
            if (pseudo.status === 'wait-to-close') return pseudo.close();
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
