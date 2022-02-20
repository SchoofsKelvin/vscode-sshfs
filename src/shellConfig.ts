import { posix as path } from 'path';
import type { Client, ClientChannel, SFTP } from "ssh2";
import type { Connection } from './connection';
import { Logger, Logging } from "./logging";
import { toPromise } from "./utils";

const SCRIPT_COMMAND_CODE = `#!/bin/sh
if [ "$#" -ne 1 ] || [ $1 = "help" ] || [ $1 = "--help" ] || [ $1 = "-h" ] || [ $1 = "-?" ]; then
    echo "Usage:";
    echo "  code <path_to_existing_file>    Will make VS Code open the file";
    echo "  code <path_to_existing_folder>  Will make VS Code add the folder as an additional workspace folder";
    echo "  code <path_to_nonexisting_file> Will prompt VS Code to create an empty file, then open it afterwards";
elif [ ! -n "$KELVIN_SSHFS_CMD_PATH" ]; then
    echo "Not running in a terminal spawned by SSH FS? Failed to sent!"
elif [ -c "$KELVIN_SSHFS_CMD_PATH" ]; then
    echo "::sshfs:code:$(pwd):::$1" >> $KELVIN_SSHFS_CMD_PATH;
    echo "Command sent to SSH FS extension";
else
    echo "Missing command shell pty of SSH FS extension? Failed to sent!"
fi
`;

type RemoteCommandInitializer = (connection: Connection) => void
    | string | string[] | undefined
    | Promise<void | string | string[] | undefined>;

async function ensureCachedFile(connection: Connection, key: string, path: string, content: string, sftp?: SFTP):
    Promise<[written: boolean, path: string | null]> {
    const rc_files: Record<string, string> = connection.cache.rc_files ||= {};
    if (rc_files[key]) return [false, rc_files[key]];
    try {
        sftp ||= await toPromise<SFTP>(cb => connection.client.sftp(cb));
        await toPromise(cb => sftp!.writeFile(path, content, { mode: 0o755 }, cb));
        return [true, rc_files[key] = path];
    } catch (e) {
        Logging.error`Failed to write ${key} file to '${path}':\n${e}`;
        return [false, null];
    }
}

async function rcInitializePATH(connection: Connection): Promise<string[] | string> {
    const dir = `/tmp/.Kelvin_sshfs.RcBin.${connection.actualConfig.username || Date.now()}`;
    const sftp = await toPromise<SFTP>(cb => connection.client.sftp(cb));
    await toPromise(cb => sftp!.mkdir(dir, { mode: 0o755 }, cb)).catch(() => { });
    const [, path] = await ensureCachedFile(connection, 'CmdCode', `${dir}/code`, SCRIPT_COMMAND_CODE, sftp);
    return path ? [
        connection.shellConfig.setEnv('PATH', `${dir}:$PATH`),
    ] : 'echo "An error occured while adding REMOTE_COMMANDS support"';
}

export interface ShellConfig {
    shell: string;
    setEnv(key: string, value: string): string;
    setupRemoteCommands: RemoteCommandInitializer;
    embedSubstitutions(command: TemplateStringsArray, ...substitutions: (string | number)[]): string;
}
const KNOWN_SHELL_CONFIGS: Record<string, ShellConfig> = {}; {
    const add = (shell: string,
        setEnv: (key: string, value: string) => string,
        setupRemoteCommands: RemoteCommandInitializer,
        embedSubstitution: (command: TemplateStringsArray, ...substitutions: (string | number)[]) => string) => {
        KNOWN_SHELL_CONFIGS[shell] = { shell, setEnv, setupRemoteCommands, embedSubstitutions: embedSubstitution };
    }
    // Ways to set an environment variable
    const setEnvExport = (key: string, value: string) => `export ${key}=${value}`;
    const setEnvSetGX = (key: string, value: string) => `set -gx ${key} ${value}`;
    const setEnvSetEnv = (key: string, value: string) => `setenv ${key} ${value}`;
    // Ways to embed a substitution
    const embedSubstitutionsBackticks = (command: TemplateStringsArray, ...substitutions: (string | number)[]): string =>
        '"' + substitutions.reduce((str, sub, i) => `${str}\`${sub}\`${command[i + 1]}`, command[0]) + '"';
    const embedSubstitutionsFish = (command: TemplateStringsArray, ...substitutions: (string | number)[]) =>
        substitutions.reduce((str, sub, i) => `${str}"(${sub})"${command[i + 1]}`, '"' + command[0]) + '"';
    // Register the known shells
    add('sh', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('bash', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('rbash', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('ash', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('dash', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('ksh', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('zsh', setEnvExport, rcInitializePATH, embedSubstitutionsBackticks);
    add('fish', setEnvSetGX, rcInitializePATH, embedSubstitutionsFish); // https://fishshell.com/docs/current/tutorial.html#autoloading-functions
    add('csh', setEnvSetEnv, rcInitializePATH, embedSubstitutionsBackticks);
    add('tcsh', setEnvSetEnv, rcInitializePATH, embedSubstitutionsBackticks);
}

export async function tryCommand(ssh: Client, command: string): Promise<string | null> {
    const exec = await toPromise<ClientChannel>(cb => ssh.exec(command, cb));
    const output = ['', ''] as [string, string];
    exec.on('data', (chunk: any) => output[0] += chunk);
    exec.stderr!.on('data', (chunk: any) => output[1] += chunk);
    await toPromise(cb => {
        exec.once('error', cb);
        exec.once('close', cb);
    }).catch(e => {
        if (typeof e !== 'number') throw e;
        throw new Error(`Command '${command}' failed with exit code ${e}${output[1] ? `:\n${output[1].trim()}` : ''}`);
    });
    if (!output[0]) {
        if (!output[1]) return null;
        throw new Error(`Command '${command}' only produced stderr:\n${output[1].trim()}`);
    }
    return output[0];
}

export async function tryEcho(ssh: Client, shellConfig: ShellConfig, variable: string): Promise<string | null> {
    const uniq = Date.now() % 1e5;
    const output = await tryCommand(ssh, `echo ${shellConfig.embedSubstitutions`::${'echo ' + uniq}:echo_result:${`echo ${variable}`}:${'echo ' + uniq}::`}`);
    return output?.match(`::${uniq}:echo_result:(.*?):${uniq}::`)?.[1] || null;
}

export async function calculateShellConfig(client: Client, logging?: Logger): Promise<ShellConfig> {
    try {
        const shellStdout = await tryCommand(client, 'echo :::SHELL:$SHELL:SHELL:::');
        const shell = shellStdout?.match(/:::SHELL:([^$].*?):SHELL:::/)?.[1];
        if (!shell) {
            if (shellStdout) logging?.error(`Could not get $SHELL from following output:\n${shellStdout}`);
            throw new Error('Could not get $SHELL');
        }
        const known = KNOWN_SHELL_CONFIGS[path.basename(shell)];
        if (known) {
            logging?.debug(`Detected known $SHELL '${shell}' (${known.shell})`);
            return known;
        } else {
            logging?.warning(`Unrecognized $SHELL '${shell}', using default ShellConfig instead`);
            return { ...KNOWN_SHELL_CONFIGS['sh'], shell };
        }
    } catch (e) {
        logging && logging.error`Error calculating ShellConfig: ${e}`;
        return { ...KNOWN_SHELL_CONFIGS['sh'], shell: '???' };
    }
}
