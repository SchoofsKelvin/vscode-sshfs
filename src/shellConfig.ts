import { posix as path } from 'path';
import type { Client, ClientChannel } from "ssh2";
import type { Logger } from "./logging";
import { toPromise } from "./utils";

export interface ShellConfig {
    shell: string;
    setEnv(key: string, value: string): string;
    setupRemoteCommands(path: string): string;
    embedSubstitutions(command: TemplateStringsArray, ...substitutions: (string | number)[]): string;
}
const KNOWN_SHELL_CONFIGS: Record<string, ShellConfig> = {}; {
    const add = (shell: string,
        setEnv: (key: string, value: string) => string,
        setupRemoteCommands: (path: string) => string,
        embedSubstitution: (command: TemplateStringsArray, ...substitutions: (string | number)[]) => string) => {
        KNOWN_SHELL_CONFIGS[shell] = { shell, setEnv, setupRemoteCommands, embedSubstitutions: embedSubstitution };
    }
    // Ways to set an environment variable
    const setEnvExport = (key: string, value: string) => `export ${key}=${value}`;
    const setEnvSetGX = (key: string, value: string) => `set -gx ${key} ${value}`;
    const setEnvSetEnv = (key: string, value: string) => `setenv ${key} ${value}`;
    // Ways to set up the remote commands script auto-execution
    const setupRemoteCommandsENV = (path: string) => [
        `export OLD_ENV="$ENV"`, // OLD_ENV ignored for now
        `export ENV="${path}"`].join('; ');
    const setupRemoteCommandsPROMPT_COMMAND = (path: string) => [
        `export ORIG_PROMPT_COMMAND="$PROMPT_COMMAND"`,
        `export PROMPT_COMMAND='source "${path}" PC; $ORIG_PROMPT_COMMAND'`].join('; ');
    const setupRemoteCommandsUnknown = () => 'echo "This shell does not yet have REMOTE_COMMANDS support"';
    // Ways to embed a substitution
    const embedSubstitutionsBackticks = (command: TemplateStringsArray, ...substitutions: (string | number)[]): string =>
        '"' + substitutions.reduce((str, sub, i) => `${str}\`${sub}\`${command[i + 1]}`, command[0]) + '"';
    const embedSubstitutionsFish = (command: TemplateStringsArray, ...substitutions: (string | number)[]) =>
        substitutions.reduce((str, sub, i) => `${str}"(${sub})"${command[i + 1]}`, '"' + command[0]) + '"';
    // Register the known shells
    add('sh', setEnvExport, setupRemoteCommandsENV, embedSubstitutionsBackticks);
    add('bash', setEnvExport, setupRemoteCommandsPROMPT_COMMAND, embedSubstitutionsBackticks);
    add('rbash', setEnvExport, setupRemoteCommandsPROMPT_COMMAND, embedSubstitutionsBackticks);
    add('ash', setEnvExport, setupRemoteCommandsENV, embedSubstitutionsBackticks);
    add('dash', setEnvExport, setupRemoteCommandsENV, embedSubstitutionsBackticks);
    add('ksh', setEnvExport, setupRemoteCommandsENV, embedSubstitutionsBackticks);
    // Shells that we know `setEnv` and `embedSubstitution` for, but don't support  `setupRemoteCommands` for yet
    add('zsh', setEnvExport, setupRemoteCommandsUnknown, embedSubstitutionsBackticks);
    add('fish', setEnvSetGX, setupRemoteCommandsUnknown, embedSubstitutionsFish); // https://fishshell.com/docs/current/tutorial.html#autoloading-functions
    add('csh', setEnvSetEnv, setupRemoteCommandsUnknown, embedSubstitutionsBackticks);
    add('tcsh', setEnvSetEnv, setupRemoteCommandsUnknown, embedSubstitutionsBackticks);
}

export async function tryCommand(ssh: Client, command: string): Promise<string | null> {
    const exec = await toPromise<ClientChannel>(cb => ssh.exec(command, cb));
    const output = ['', ''] as [string, string];
    exec.stdout.on('data', (chunk: any) => output[0] += chunk);
    exec.stderr.on('data', (chunk: any) => output[1] += chunk);
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
