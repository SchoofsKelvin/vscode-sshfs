
import { ConfigLocation, FileSystemConfig, invalidConfigName, parseConnectionString } from 'common/fileSystemConfig';
import { readFile, writeFile } from 'fs';
import { parse as parseJsonc, ParseError } from 'jsonc-parser';
import * as semver from 'semver';
import * as vscode from 'vscode';
import { Logging } from './logging';
import { toPromise } from './utils';

// Logger scope with default warning/error options (which enables stacktraces) disabled
const logging = Logging.scope(undefined, false);
logging.warning.options = {};
logging.error.options = {};

function randomAvailableName(configs: FileSystemConfig[], index = 0): [string, number] {
  let name = index ? `unnamed${index}` : 'unnamed';
  while (configs.find(c => c.name === name)) {
    index += 1;
    name = `unnamed${index}`;
  }
  return [name, index + 1];
}

export async function renameNameless() {
  const conf = vscode.workspace.getConfiguration('sshfs');
  const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
  let randomIndex = 0;
  const configs = [
    ...(inspect.globalValue || []),
    ...(inspect.workspaceValue || []),
    ...(inspect.workspaceFolderValue || []),
  ];
  function patch(v: FileSystemConfig[] | undefined, loc: vscode.ConfigurationTarget) {
    if (!v) return;
    let okay = true;
    v.forEach((config) => {
      if (!config.name) {
        [config.name, randomIndex] = randomAvailableName(configs, randomIndex);
        logging.warning(`Renamed unnamed config to ${config.name}`);
        okay = false;
      }
    });
    if (okay) return;
    return conf.update('configs', v, loc).then(() => { }, res => logging.error`Error while saving configs (CT=${loc}): ${res}`);
  }
  await patch(inspect.globalValue, vscode.ConfigurationTarget.Global);
  await patch(inspect.workspaceValue, vscode.ConfigurationTarget.Workspace);
  await patch(inspect.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
}

let loadedConfigs: FileSystemConfig[] = [];
export function getConfigs() {
  return loadedConfigs;
}

export const UPDATE_LISTENERS: ((configs: FileSystemConfig[]) => any)[] = [];

async function readConfigFile(location: string, shouldExist = false): Promise<FileSystemConfig[]> {
  const content = await toPromise<Buffer>(cb => readFile(location, cb)).catch((e: NodeJS.ErrnoException) => e);
  if (content instanceof Error) {
    if (content.code === 'ENOENT' && !shouldExist) return [];
    logging.error`Error while reading config file ${location}: ${content}`;
    return [];
  }
  const errors: ParseError[] = [];
  const parsed: FileSystemConfig[] | null = parseJsonc(content.toString(), errors);
  if (!parsed || errors.length) {
    logging.error`Couldn't parse ${location} as a 'JSON with Comments' file`;
    vscode.window.showErrorMessage(`Couldn't parse ${location} as a 'JSON with Comments' file`);
    return [];
  }
  parsed.forEach(c => c._locations = [c._location = location]);
  logging.debug`Read ${parsed.length} configs from ${location}`;
  return parsed;
}

export function getConfigLocations(): ConfigLocation[] {
  // Fetch configs from vscode settings
  const config = vscode.workspace.getConfiguration('sshfs');
  const configpaths = { workspace: [] as string[], global: [] as string[] };
  if (config) {
    const inspect2 = config.inspect<string[]>('configpaths')!;
    configpaths.workspace = inspect2.workspaceValue || [];
    configpaths.global = inspect2.globalValue || [];
  }
  return [...configpaths.workspace, ...configpaths.global];
}

export async function loadConfigsRaw(): Promise<FileSystemConfig[]> {
  logging.info('Loading configurations...');
  await renameNameless();
  // Keep all found configs "ordened" by layer, for proper deduplication/merging
  const layered = {
    folder: [] as FileSystemConfig[],
    workspace: [] as FileSystemConfig[],
    global: [] as FileSystemConfig[],
  };
  // Fetch configs from vscode settings
  const config = vscode.workspace.getConfiguration('sshfs');
  const configpaths = { workspace: [] as string[], global: [] as string[] };
  if (config) {
    const inspect = config.inspect<FileSystemConfig[]>('configs')!;
    // Note: workspaceFolderValue not used here, we do it later for all workspace folders
    layered.workspace = inspect.workspaceValue || [];
    layered.global = inspect.globalValue || [];
    layered.workspace.forEach(c => c._locations = [c._location = vscode.ConfigurationTarget.Workspace]);
    layered.global.forEach(c => c._locations = [c._location = vscode.ConfigurationTarget.Global]);
    // Get all sshfs.configpaths values into an array
    const inspect2 = config.inspect<string[]>('configpaths')!;
    configpaths.workspace = inspect2.workspaceValue || [];
    configpaths.global = inspect2.globalValue || [];
  }
  // Fetch configs from config files
  for (const location of configpaths.workspace) {
    layered.workspace = [
      ...layered.workspace,
      ...await readConfigFile(location, true),
    ];
  }
  for (const location of configpaths.global) {
    layered.global = [
      ...layered.global,
      ...await readConfigFile(location, true),
    ];
  }
  // Fetch configs from opened folders (workspaces)
  // Should we really support workspace folders, and not just workspaces?
  /*
  const { workspaceFolders } = vscode.workspace;
  if (workspaceFolders) {
    for (const { uri } of workspaceFolders) {
      if (uri.scheme !== 'file') continue;
      const fConfig = vscode.workspace.getConfiguration('sshfs', uri).inspect<FileSystemConfig[]>('configs');
      const fConfigs = fConfig && fConfig.workspaceFolderValue || [];
      if (fConfigs.length) {
        logging.debug`Read ${fConfigs.length} configs from workspace folder ${uri}`;
        fConfigs.forEach(c => c._locations = [c._location = `WorkspaceFolder ${uri}`]);
      }
      layered.folder = [
        ...await readConfigFile(path.resolve(uri.fsPath, 'sshfs.json')),
        ...await readConfigFile(path.resolve(uri.fsPath, 'sshfs.jsonc')),
        ...fConfigs,
        ...layered.folder,
      ];
    }
  }*/
  // Store all configs in one array, in order of importance
  const all = [...layered.folder, ...layered.workspace, ...layered.global];
  all.forEach(c => c.name = (c.name || '').toLowerCase()); // It being undefined shouldn't happen, but better be safe
  // Let the user do some cleaning with the raw configs
  for (const conf of all) {
    if (!conf.name) {
      logging.error`Skipped an invalid SSH FS config (missing a name field):\n${conf}`;
      vscode.window.showErrorMessage(`Skipped an invalid SSH FS config (missing a name field)`);
    } else if (invalidConfigName(conf.name)) {
      logging.warning(`Found a SSH FS config with the invalid name "${conf.name}", prompting user how to handle`);
      vscode.window.showErrorMessage(`Invalid SSH FS config name: ${conf.name}`, 'Rename', 'Delete', 'Skip').then(async (answer) => {
        if (answer === 'Rename') {
          const name = await vscode.window.showInputBox({ prompt: `New name for: ${conf.name}`, validateInput: invalidConfigName, placeHolder: 'New name' });
          if (name) {
            const oldName = conf.name;
            logging.info`Renaming config "${oldName}" to "${name}"`;
            conf.name = name;
            return updateConfig(conf, oldName);
          }
        } else if (answer === 'Delete') {
          return deleteConfig(conf);
        }
        logging.warning`Skipped SSH FS config '${conf.name}'`;
        vscode.window.showWarningMessage(`Skipped SSH FS config '${conf.name}'`);
      });
    }
  }
  // After cleaning up, ignore the configurations that are still bad
  return all.filter(c => !invalidConfigName(c.name));
}

export async function loadConfigs(): Promise<FileSystemConfig[]> {
  const all = await loadConfigsRaw();
  // Remove duplicates, merging those where the more specific config has `merge` set
  // Folder comes before Workspace, comes before Global
  const configs: FileSystemConfig[] = [];
  for (const conf of all) {
    const dup = configs.find(d => d.name === conf.name);
    if (dup) {
      if (dup.merge) {
        // The folder settings should overwrite the higher up defined settings
        // Since .sshfs.json gets read after vscode settings, these can overwrite configs
        // of the same level, which I guess is a nice feature?
        logging.debug`\tMerging duplicate ${conf.name} from ${conf._locations}`;
        dup._locations = [...dup._locations, ...conf._locations];
        Object.assign(dup, Object.assign(conf, dup));
      } else {
        logging.debug`\tIgnoring duplicate ${conf.name} from ${conf._locations}`;
      }
    } else {
      logging.debug`\tAdded configuration ${conf.name} from ${conf._locations}`;
      configs.push(conf);
    }
  }
  loadedConfigs = configs;
  logging.info`Found ${loadedConfigs.length} configurations`;
  UPDATE_LISTENERS.forEach(listener => listener(loadedConfigs));
  return loadedConfigs;
}

export type ConfigAlterer = (configs: FileSystemConfig[]) => FileSystemConfig[] | null | false;
export async function alterConfigs(location: ConfigLocation, alterer: ConfigAlterer) {
  switch (location) {
    case vscode.ConfigurationTarget.Global:
    case vscode.ConfigurationTarget.Workspace:
    case vscode.ConfigurationTarget.WorkspaceFolder:
      const conf = vscode.workspace.getConfiguration('sshfs');
      const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
      // If the array doesn't exist, create a new empty one
      const array = [, inspect.globalValue, inspect.workspaceValue, inspect.workspaceFolderValue][location] || [];
      let modified = alterer(array);
      if (!modified) return;
      modified = modified.map((config) => {
        const newConfig = { ...config };
        for (const key in config) {
          if (key[0] === '_') delete newConfig[key];
        }
        return newConfig;
      });
      await conf.update('configs', modified, location);
      logging.debug`\tUpdated configs in ${[, 'Global', 'Workspace', 'WorkspaceFolder'][location]} settings.json`;
      return;
  }
  if (typeof location !== 'string') throw new Error(`Invalid _location field: ${location}`);
  const configs = await readConfigFile(location, true);
  let altered = alterer(configs);
  if (!altered) return;
  altered = altered.map((config) => {
    const newConfig = { ...config };
    for (const key in config) {
      if (key[0] === '_') delete newConfig[key];
    }
    return newConfig;
  });
  const data = JSON.stringify(altered, null, 4);
  await toPromise(cb => writeFile(location, data, cb))
    .catch((e: NodeJS.ErrnoException) => {
      logging.error`Error while writing configs to ${location}: ${e}`;
      throw e;
    });
  logging.debug`\tWritten modified configs to ${location}`;
  await loadConfigs();
}

export async function updateConfig(config: FileSystemConfig, oldName = config.name) {
  const { name, _location } = config;
  if (!name) throw new Error(`The given config has no name field`);
  if (!_location) throw new Error(`The given config has no _location field`);
  logging.info`Saving config ${name} to ${_location}`;
  if (oldName !== config.name) {
    logging.debug`\tSaving ${name} will try to overwrite old config ${oldName}`;
  }
  await alterConfigs(_location, (configs) => {
    logging.debug`\tConfig location '${_location}' has following configs: ${configs.map(c => c.name).join(', ')}`;
    const index = configs.findIndex(c => c.name ? c.name.toLowerCase() === oldName.toLowerCase() : false);
    if (index === -1) {
      logging.debug`\tAdding the new config to the existing configs`;
      configs.push(config);
    } else {
      logging.debug`\tOverwriting config '${configs[index].name}' at index ${index} with the new config`;
      configs[index] = config;
    }
    return configs;
  });
}

export async function deleteConfig(config: FileSystemConfig) {
  const { name, _location } = config;
  if (!name) throw new Error(`The given config has no name field`);
  if (!_location) throw new Error(`The given config has no _location field`);
  logging.info`Deleting config ${name} in ${_location}`;
  await alterConfigs(_location, (configs) => {
    logging.debug`\tConfig location '${_location}' has following configs: ${configs.map(c => c.name).join(', ')}`;
    const index = configs.findIndex(c => c.name ? c.name.toLowerCase() === name.toLowerCase() : false);
    if (index === -1) throw new Error(`Config '${name}' not found in ${_location}`);
    logging.debug`\tDeleting config '${configs[index].name}' at index ${index}`;
    configs.splice(index, 1);
    return configs;
  });
}

/** If a loaded config with the given name exists (case insensitive), it is returned.
 * Otherwise, if it contains a `@`, we parse it as a connection string.
 * If this results in no (valid) configuration, `undefined` is returned.
 */
export function getConfig(input: string): FileSystemConfig | undefined {
  const lower = input.toLowerCase();
  const loaded = getConfigs().find(c => c.name.toLowerCase() === lower);
  if (loaded) return loaded;
  if (!input.includes('@')) return undefined;
  const parseString = parseConnectionString(input);
  if (typeof parseString === 'string') return undefined;
  const [parsed] = parseString;
  // If we're using the instant connection string, the host name might be a config name
  const existing = getConfigs().find(c => c.name.toLowerCase() === parsed.host!.toLowerCase());
  if (existing) {
    Logging.info`getConfig('${input}') led to '${parsed.name}' which matches config '${existing.name}'`;
    // Take the existing config, but (more or less) override it with the values present in `parsed`
    // `name` be the same as in `parsed`, meaning it can be reused with `getConfig` on window reload.
    return {
      ...existing, ...parsed,
      host: existing.host || parsed.host, // `parsed.host` is the session name, which might not be the actual hostname
      _location: undefined, // Since this is a merged config, we have to flag it as such
      _locations: [...existing._locations, ...parsed._locations], // Merge locations
    };
  }
  return parsed;
}

function valueMatches(a: any, b: any): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (!a || !b) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => valueMatches(value, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!valueMatches(a[key], b[key])) return false;
  }
  return true;
}

export function configMatches(a: FileSystemConfig, b: FileSystemConfig): boolean {
  // This is kind of the easiest and most robust way of checking if configs are identical.
  // If it wasn't for `loadedConfigs` (and its contents) regularly being fully recreated, we
  // could just use === between the two configs. This'll do for now.
  return valueMatches(a, b);
}

vscode.workspace.onDidChangeConfiguration(async (e) => {
  // if (!e.affectsConfiguration('sshfs.configs')) return;
  return loadConfigs();
});

function parseFlagList(list: string[] | undefined, origin: string): Record<string, FlagCombo> {
  if (list === undefined) return {};
  if (!Array.isArray(list)) throw new Error(`Expected string array for flags, but got: ${list}`);
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
    if (name in scope) continue;
    scope[name] = [value, origin];
  }
  return scope;
}

/* List of flags
  DF-GE (boolean) (default=false)
    - Disables the 'diffie-hellman-group-exchange' kex algorithm as a default option
    - Originally for issue #239
    - Automatically enabled for Electron v11.0, v11.1 and v11.2
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
  FS_NOTIFY_ERRORS (boolean) (default=false)
    - Enables displaying error notifications when a file system operation fails and isn't automatically ignored
    - Automatically enabled VS Code 1.56 and later (see issue #282)
*/
export type FlagValue = string | boolean | null;
export type FlagCombo<V extends FlagValue = FlagValue> = [value: V, origin: string];

const globalFlagsSubscribers = new Set<() => void>();
export function subscribeToGlobalFlags(listener: () => void): vscode.Disposable {
  listener();
  globalFlagsSubscribers.add(listener);
  return new vscode.Disposable(() => globalFlagsSubscribers.delete(listener));
}

export const DEFAULT_FLAGS: string[] = [];
let cachedFlags: Record<string, FlagCombo> = {};
function calculateFlags(): Record<string, FlagCombo> {
  const flags: Record<string, FlagCombo> = {};
  const config = vscode.workspace.getConfiguration('sshfs').inspect<string[]>('flags');
  if (!config) throw new Error(`Could not inspect "sshfs.flags" config field`);
  const applyList = (list: string[] | undefined, origin: string) => Object.assign(flags, parseFlagList(list, origin));
  applyList(DEFAULT_FLAGS, 'Built-in Default');
  applyList(config.defaultValue, 'Default Settings');
  // Electron v11 crashes for DiffieHellman GroupExchange, although it's fixed in 11.3.0
  if ((process.versions as { electron?: string }).electron?.match(/^11\.(0|1|2)\./)) {
    applyList(['+DF-GE'], 'Fix for issue #239')
  }
  // Starting with 1.56, FileSystemProvider errors aren't shown to the user and just silently fail
  // https://github.com/SchoofsKelvin/vscode-sshfs/issues/282
  if (semver.gte(vscode.version, '1.56.0')) {
    applyList(['+FS_NOTIFY_ERRORS'], 'Fix for issue #282');
  }
  applyList(config.globalValue, 'Global Settings');
  applyList(config.workspaceValue, 'Workspace Settings');
  applyList(config.workspaceFolderValue, 'WorkspaceFolder Settings');
  Logging.info`Calculated config flags: ${flags}`;
  return cachedFlags = flags;
}

vscode.workspace.onDidChangeConfiguration(event => {
  if (event.affectsConfiguration('sshfs.flags')) calculateFlags();
});
calculateFlags();

/**
 * Returns (a copy of the) global flags. Gets updated by ConfigurationChangeEvent events.
 * In case `flags` is given, flags specified in this array will override global ones in the returned result.
 * @param flags An optional array of flags to check before the global ones
 */
export function getFlags(flags?: string[]): Record<string, FlagCombo> {
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
  if (!combo) return [missingValue, 'missing'];
  const [value, reason] = combo;
  if (value == null) return [true, reason];
  if (typeof value === 'boolean') return [value, reason];
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === 't' || lower === 'yes' || lower === 'y') return [true, reason];
  if (lower === 'false' || lower === 'f' || lower === 'no' || lower === 'n') return [false, reason];
  throw new Error(`Could not convert '${value}' for flag '${target}' to a boolean!`);
}
