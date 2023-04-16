import * as semver from 'semver';
import * as vscode from 'vscode';
import { Logging } from './logging';
import { catchingPromise } from './utils';

/* List of flags
  DF-GE (boolean) (default=false)
    - Disables the 'diffie-hellman-group-exchange' kex algorithm as a default option
    - Originally for issue #239
    - Automatically enabled for Electron v11.0, v11.1 and v11.2
  OPENSSH-SHA1 (boolean) (default=true)
    - Patch for issue #309 where OpenSSH 8.8+ refuses `ssh-rsa` keys using SHA1 (which is what ssh2 uses)
    - The patch (see `.yarn/patches/*-convertSha1.patch`) adds an option for `agent` and `publickey` authentications
    - With this option enabled, the patch will, if the server supports it, make ssh2 use SHA512/SHA256 for `ssh-rsa` keys
    / Mind that this option applies for every server, the patch doesn't (currently) check whether it's OpenSSH 8.8+
  DEBUG_SSH2 (boolean) (default=false)
    - Enables debug logging in the ssh2 library (set at the start of each connection)
  WINDOWS_COMMAND_SEPARATOR (boolean) (default=false)
    - Makes it that commands are joined together using ` && ` instead of `; `
    - Automatically enabled when the remote shell is detected to be PowerShell or Command Prompt (cmd.exe)
  CHECK_HOME (boolean) (default=true)
    - Determines whether we check if the home directory exists during `createFileSystem` in the Manager
    - If `tryGetHome` fails while creating the connection, throw an error if this flag is set, otherwise default to `/`
  REMOTE_COMMANDS (boolean) (default=false)
    - Enables automatically launching a background command terminal during connection setup
    - Enables attempting to inject a file to be sourced by the remote shells (which adds the `code` alias)
  DEBUG_REMOTE_COMMANDS (boolean) (default=false)
    - Enables debug logging for the remote command terminal (thus useless if REMOTE_COMMANDS isn't true)
  DEBUG_FS (string) (default='')
    - A comma-separated list of debug flags for logging errors in the sshFileSystem
    - The presence of `showignored` will log `FileNotFound` that got ignored
    - The presence of `disableignored` will make the code ignore nothing (making `showignored` useless)
    - The presence of `minimal` will log all errors as single lines, but not `FileNotFound`
    - The presence of `full` is the same as `minimal` but with full stacktraces
    - The presence of `converted` will log the resulting converted errors (if required and successful)
    - The presence of `all` enables all of the above except `disableignored` (similar to `showignored,full,converted`)
  DEBUG_FSR (string) (default='', global)
    - A comma-separated list of method names to enable logging for in the FileSystemRouter
    - The presence of `all` is equal to `stat,readDirectory,createDirectory,readFile,writeFile,delete,rename`
    - The router logs handles `ssh://`, and will even log operations to non-existing configurations/connections
  FS_NOTIFY_ERRORS (string)
    - A comma-separated list of operations to display notifications for should they error
    - Mind that `FileNotFound` errors for ignored paths are always ignored, except with `DEBUG_FS=showignored`
    - The presence of `all` will show notification for every operation
    - The presence of `write` is equal to `createDirectory,writeFile,delete,rename`
    - Besides those provided by  `write`, there's also `readDirectory`, `readFile` and `stat`
    - Automatically set to `write` for VS Code 1.56 and later (see issue #282), otherwise ''
  SHELL_CONFIG (string)
    - Forces the use of a specific shell configuration. Check shellConfig.ts for possible values
    - By default, when this flag is absent (or an empty or not a string), the extension will try to detect the correct type to use
*/

function parseFlagList(list: string[] | undefined, origin: string): Record<string, FlagCombo> {
  if (list === undefined)
    return {};
  if (!Array.isArray(list))
    throw new Error(`Expected string array for flags, but got: ${list}`);
  const scope: Record<string, FlagCombo> = {};
  for (const flag of list) {
    let name: string = flag;
    let value: FlagValue = null;
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      name = flag.substring(0, eq);
      value = flag.substring(eq + 1);
    } else if (flag.startsWith('+')) {
      name = flag.substring(1);
      value = true;
    } else if (flag.startsWith('-')) {
      name = flag.substring(1);
      value = false;
    }
    name = name.toLocaleLowerCase();
    if (name in scope)
      continue;
    scope[name] = [value, origin];
  }
  return scope;
}

export type FlagValue = string | boolean | null;
export type FlagCombo<V extends FlagValue = FlagValue> = [value: V, origin: string];
const globalFlagsSubscribers = new Set<() => void>();
export function subscribeToGlobalFlags(listener: () => void): vscode.Disposable {
  listener();
  globalFlagsSubscribers.add(listener);
  return new vscode.Disposable(() => globalFlagsSubscribers.delete(listener));
}

const DEFAULT_FLAGS: string[] = [];
let cachedFlags: Record<string, FlagCombo> = {};
function calculateFlags(): Record<string, FlagCombo> {
  const flags: Record<string, FlagCombo> = {};
  const config = vscode.workspace.getConfiguration('sshfs').inspect<string[]>('flags');
  if (!config)
    throw new Error(`Could not inspect "sshfs.flags" config field`);
  const applyList = (list: string[] | undefined, origin: string) => Object.assign(flags, parseFlagList(list, origin));
  applyList(DEFAULT_FLAGS, 'Built-in Default');
  applyList(config.defaultValue, 'Default Settings');
  // Electron v11 crashes for DiffieHellman GroupExchange, although it's fixed in 11.3.0
  if ((process.versions as { electron?: string; }).electron?.match(/^11\.(0|1|2)\./)) {
    applyList(['+DF-GE'], 'Fix for issue #239');
  }
  // Starting with 1.56, FileSystemProvider errors aren't shown to the user and just silently fail
  // https://github.com/SchoofsKelvin/vscode-sshfs/issues/282
  if (semver.gte(vscode.version, '1.56.0')) {
    applyList(['FS_NOTIFY_ERRORS=write'], 'Fix for issue #282');
  }
  applyList(config.globalValue, 'Global Settings');
  applyList(config.workspaceValue, 'Workspace Settings');
  applyList(config.workspaceFolderValue, 'WorkspaceFolder Settings');
  Logging.info`Calculated config flags: ${flags}`;
  for (const listener of globalFlagsSubscribers) {
    catchingPromise(listener).catch(e => Logging.error`onGlobalFlagsChanged listener errored: ${e}`);
  }
  return cachedFlags = flags;
}
vscode.workspace.onDidChangeConfiguration(event => {
  if (event.affectsConfiguration('sshfs.flags'))
    calculateFlags();
});
calculateFlags();

/**
 * Returns (a copy of the) global flags. Gets updated by ConfigurationChangeEvent events.
 * In case `flags` is given, flags specified in this array will override global ones in the returned result.
 * @param flags An optional array of flags to check before the global ones
 */
function getFlags(flags?: string[]): Record<string, FlagCombo> {
  return {
    ...cachedFlags,
    ...parseFlagList(flags, 'Override'),
  };
}

/**
 * Checks the `sshfs.flags` config (overridable by e.g. workspace settings).
 * - Flag names are case-insensitive
 * - If a flag appears twice, the first mention of it is used
 * - If a flag appears as "NAME", `null` is returned
 * - If a flag appears as "FLAG=VALUE", `VALUE` is returned as a string
 * - If a flag appears as `+FLAG` (and no `=`), `true` is returned (as a boolean)
 * - If a flag appears as `-FLAG` (and no `=`), `false` is returned (as a boolean)
 * - If a flag is missing, `undefined` is returned (different from `null`!)
 *
 * For `undefined`, an actual `undefined` is returned. For all other cases, a FlagCombo
 * is returned, e.g. "NAME" returns `[null, "someOrigin"]` and `"+F"` returns `[true, "someOrigin"]`
 * @param target The name of the flag to look for
 * @param flags An optional array of flags to check before the global ones
 */
export function getFlag(target: string, flags?: string[]): FlagCombo | undefined {
  return getFlags(flags)[target.toLowerCase()];
}

/**
 * Built on top of getFlag. Tries to convert the flag value to a boolean using these rules:
 * - If the flag isn't present, `missingValue` is returned
 *   Although this probably means I'm using a flag that I never added to `DEFAULT_FLAGS`
 * - Booleans are kept
 * - `null` is counted as `true` (means a flag like "NAME" was present without any value or prefix)
 * - Strings try to get converted in a case-insensitive way:
 *  - `true/t/yes/y` becomes true
 *  - `false/f/no/n` becomes false
 *  - All other strings result in an error
 * @param target The name of the flag to look for
 * @param defaultValue The value to return when no flag with the given name is present
 * @param flags An optional array of flags to check before the global ones
 * @returns The matching FlagCombo or `[missingValue, 'missing']` instead
 */
export function getFlagBoolean(target: string, missingValue: boolean, flags?: string[]): FlagCombo<boolean> {
  const combo = getFlag(target, flags);
  if (!combo)
    return [missingValue, 'missing'];
  const [value, reason] = combo;
  if (value == null)
    return [true, reason];
  if (typeof value === 'boolean')
    return [value, reason];
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 't' || lower === 'yes' || lower === 'y')
    return [true, reason];
  if (lower === 'false' || lower === 'f' || lower === 'no' || lower === 'n')
    return [false, reason];
  throw new Error(`Could not convert '${value}' for flag '${target}' to a boolean!`);
}
