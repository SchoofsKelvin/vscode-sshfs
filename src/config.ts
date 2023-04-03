
import { ConfigLocation, FileSystemConfig, invalidConfigName, isFileSystemConfig, parseConnectionString } from 'common/fileSystemConfig';
import { ParseError, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import * as path from 'path';
import * as vscode from 'vscode';
import { MANAGER } from './extension';
import { Logging, OUTPUT_CHANNEL } from './logging';
import { catchingPromise } from './utils';

const fs = vscode.workspace.fs;

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

// TODO: Do this better, especially since we can dynamically start adding configs (for workspaceFolders)
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

async function readConfigFile(file: vscode.Uri, quiet: boolean): Promise<FileSystemConfig[] | undefined> {
  const content = await fs.readFile(file).then<Uint8Array | NodeJS.ErrnoException>(v => v, e => e);
  if (content instanceof Error) {
    if (content.code === 'ENOENT' && quiet) return undefined;
    logging.error`Error while reading config file ${file}: ${content}`;
    return undefined;
  }
  const errors: ParseError[] = [];
  const parsed: FileSystemConfig[] | null = parseJsonc(Buffer.from(content.buffer).toString(), errors);
  if (!parsed || errors.length) {
    const formatted = errors.map(({ error, offset, length }) => `${printParseErrorCode(error)} at ${offset}-${offset + length}`);
    logging.error`Couldn't parse ${file} due to invalid JSON:\n${formatted.join('\n')}`;
    vscode.window.showErrorMessage(`Couldn't parse the SSH FS config file at ${file}, invalid JSON`);
    return [];
  }
  parsed.forEach(c => c._locations = [c._location = file.toString()]);
  logging.debug`Read ${parsed.length} configs from ${file}`;
  return parsed;
}

async function readConfigDirectory(uri: vscode.Uri, quiet: boolean): Promise<FileSystemConfig[] | undefined> {
  const stat = await fs.stat(uri).then(e => e, () => undefined);
  if (!stat) return undefined;
  const files = await fs.readDirectory(uri); // errors if not a directory
  logging.debug`readConfigDirectory got files: ${files}`;
  const parsed = await Promise.all(files
    .filter(([, t]) => t & vscode.FileType.File).map(([f]) => f)
    .filter(file => file.endsWith('.json') || file.endsWith('.jsonc'))
    .map(file => readConfigFile(vscode.Uri.joinPath(uri, file), quiet)));
  return parsed.some(Boolean) ? parsed.filter(Array.isArray).flat() : undefined;
}

const skipDisconnectedUri = (uri: vscode.Uri) => uri.scheme === 'ssh' && !MANAGER?.connectionManager.getActiveConnection(uri.authority);

async function findConfigs(uri: vscode.Uri, quiet: boolean): Promise<FileSystemConfig[] | undefined> {
  if (uri.scheme === 'ssh') {
    // Ignore SSH URIs for connections that are still connecting
    if (skipDisconnectedUri(uri)) {
      logging.debug`Skipping config file '${uri}' for disconnected config`;
      return [];
    }
  }
  try {
    return await readConfigDirectory(uri, quiet);
  } catch {
    return await readConfigFile(uri, quiet);
  }
}

/**
 * Tries to read all configs from all possible locations matching the given location.
 * This function will report errors to the user/logger, and never reject. An empty array may be returned.
 * This function might read multiple files when given a path to a directory, and will aggregate the results.
 * Will return `undefined` if the given file doesn't exist, or lead to a directory with no readable config files.
 * Will return an empty array if the given path is a relative path.
 */
async function findConfigFiles(location: string | vscode.Uri, quiet = false): Promise<[configs: FileSystemConfig[] | undefined, isAbsolute: boolean]> {
  if (location instanceof vscode.Uri) {
    return [await findConfigs(location, quiet), true];
  } else if (location.match(/^([a-zA-Z0-9+.-]+):/)) {
    return [await findConfigs(vscode.Uri.parse(location), quiet), true];
  } else if (path.isAbsolute(location)) {
    return [await findConfigs(vscode.Uri.file(location), quiet), true];
  }
  return [[], false];
}

async function tryFindConfigFiles(location: string | vscode.Uri, source: string): Promise<FileSystemConfig[]> {
  const [found, isAbsolute] = await findConfigFiles(location, true);
  if (found) return found;
  logging[isAbsolute ? 'error' : 'info']`No configs found in '${location}' provided by ${source}`;
  return [];
}

function getConfigPaths(scope?: vscode.WorkspaceFolder): Record<'global' | 'workspace' | 'folder', string[]> {
  const config = vscode.workspace.getConfiguration('sshfs', scope);
  const inspect = config.inspect<string[]>('configpaths')!;
  return {
    global: inspect.globalValue || [],
    workspace: inspect.workspaceValue || [],
    folder: inspect.workspaceFolderValue || [],
  };
}

let configLayers: {
  global: FileSystemConfig[];
  workspace: FileSystemConfig[];
  folder: Map<string, FileSystemConfig[]>;
};

/** Only loads `sshfs.configs` into `configLayers`, ignoring `sshfs.configpaths` */
async function loadGlobalOrWorkspaceConfigs(): Promise<void> {
  const config = vscode.workspace.getConfiguration('sshfs');
  const inspect = config.inspect<FileSystemConfig[]>('configs')!;
  configLayers.global = inspect.globalValue || [];
  configLayers.workspace = inspect.workspaceValue || [];
  configLayers.global.forEach(c => c._locations = [c._location = vscode.ConfigurationTarget.Global]);
  configLayers.workspace.forEach(c => c._locations = [c._location = vscode.ConfigurationTarget.Workspace]);
}

/** Loads `sshfs.configs` and (including global/workspace-provided) relative `sshfs.configpaths` into `configLayers` */
async function loadWorkspaceFolderConfigs(folder: vscode.WorkspaceFolder): Promise<FileSystemConfig[]> {
  if (skipDisconnectedUri(folder.uri)) {
    configLayers.folder.set(folder.uri.toString(), []);
    return [];
  }
  const config = vscode.workspace.getConfiguration('sshfs', folder).inspect<FileSystemConfig[]>('configs');
  const configs = config && config.workspaceFolderValue || [];
  if (configs.length) {
    logging.debug`Read ${configs.length} configs from workspace folder ${folder.uri}`;
    configs.forEach(c => c._locations = [c._location = `WorkspaceFolder ${folder.uri}`]);
  }
  const configPaths = getConfigPaths(folder);
  for (const location of [...configPaths.global, ...configPaths.workspace, ...configPaths.folder]) {
    if (path.isAbsolute(location)) continue;
    const uri = vscode.Uri.joinPath(folder.uri, location);
    const found = await tryFindConfigFiles(uri, `WorkspaceFolder '${folder.uri}'`);
    if (found) configs.push(...found);
  }
  configLayers.folder.set(folder.uri.toString(), configs);
  return configs;
}

function applyConfigLayers(): void {
  // Merge all layers into a single array of configs, in order of importance
  const all: FileSystemConfig[] = [
    ...(vscode.workspace.workspaceFolders || []).flatMap(ws => configLayers.folder.get(ws.uri.toString()) || []),
    ...configLayers.workspace,
    ...configLayers.global,
  ];
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
  // Remove duplicates, merging those where the more specific config has `merge` set (in the order from above)
  loadedConfigs = [];
  for (const conf of all.filter(c => !invalidConfigName(c.name))) {
    const dup = loadedConfigs.find(d => d.name === conf.name);
    if (dup) {
      if (dup.merge) {
        logging.debug`\tMerging duplicate ${conf.name} from ${conf._locations}`;
        dup._locations = [...dup._locations, ...conf._locations];
        Object.assign(dup, { ...conf, ...dup });
      } else {
        logging.debug`\tIgnoring duplicate ${conf.name} from ${conf._locations}`;
      }
    } else {
      logging.debug`\tAdded configuration ${conf.name} from ${conf._locations}`;
      loadedConfigs.push(conf);
    }
  }
  // Handle configs extending other configs
  type BuildData = { source: FileSystemConfig; result?: FileSystemConfig; skipped?: boolean };
  const buildData = new Map<string, BuildData>();
  let building: BuildData[] = [];
  loadedConfigs.forEach(c => buildData.set(c.name, { source: c }));
  function getOrBuild(name: string): BuildData | undefined {
    const data = buildData.get(name);
    // Handle special cases (missing, built, skipped or looping)
    if (!data || data.result || data.skipped || building.includes(data)) return data;
    // Start building the resulting config
    building.push(data);
    const result = { ...data.source };
    // Handle extending
    let extend = result.extend;
    if (typeof extend === 'string') extend = [extend];
    for (const depName of extend || []) {
      const depData = getOrBuild(depName);
      if (!depData) {
        logging.error`\tSkipping "${name}" because it extends unknown config "${depName}"`;
        building.pop()!.skipped = true;
        return data;
      } else if (depData.skipped && !data.skipped) {
        logging.error`\tSkipping "${name}" because it extends skipped config "${depName}"`;
        building.pop()!.skipped = true;
        return data;
      } else if (data.skipped || building.includes(depData)) {
        logging.error`\tSkipping "${name}" because it extends config "${depName}" which (indirectly) extends "${name}"`;
        if (building.length) logging.debug`\t\tdetected cycle: ${building.map(b => b.source.name).join(' -> ')} -> ${depName}`;
        building.splice(building.indexOf(depData)).forEach(d => d.skipped = true);
        return data;
      }
      logging.debug`\tExtending "${name}" with "${depName}"`;
      Object.assign(result, depData.result);
    }
    building.pop();
    data.result = Object.assign(result, data.source);
    return data;
  }
  loadedConfigs = loadedConfigs.map(c => getOrBuild(c.name)?.result).filter(isFileSystemConfig);
  if (loadedConfigs.length < buildData.size) {
    vscode.window.showErrorMessage(`Skipped some SSH FS configs due to incorrect "extend" options`, 'See logs').then(answer => {
      if (answer === 'See logs') OUTPUT_CHANNEL.show(true);
    });
  }
  // And we're done
  logging.info`Applied config layers resulting in ${loadedConfigs.length} configurations`;
  UPDATE_LISTENERS.forEach(listener => listener(loadedConfigs));
}

export let LOADING_CONFIGS: Promise<FileSystemConfig[]>;
export async function loadConfigs(): Promise<FileSystemConfig[]> {
  return LOADING_CONFIGS = catchingPromise(async loaded => {
    logging.info('Loading configurations...');
    await renameNameless();
    // Keep all found configs "ordened" by layer, for proper deduplication/merging
    // while also allowing partially refreshing (workspaceFolder configs) without having to reload *everything*
    configLayers = { global: [], workspace: [], folder: new Map() };
    // Fetch global/workspace configs from vscode settings
    loadGlobalOrWorkspaceConfigs();
    // Fetch configs from config files defined in global/workspace settings
    const configpaths = getConfigPaths();
    for (const location of configpaths.global) {
      configLayers.global.push(...await tryFindConfigFiles(location, 'Global Settings'));
    }
    for (const location of configpaths.workspace) {
      configLayers.workspace.push(...await tryFindConfigFiles(location, 'Workspace Settings'));
    }
    // Fetch configs from opened folders
    for (const folder of vscode.workspace.workspaceFolders || []) {
      await loadWorkspaceFolderConfigs(folder);
    }
    applyConfigLayers();
    loaded(loadedConfigs);
  });
}
loadConfigs();

export async function reloadWorkspaceFolderConfigs(authority: string): Promise<void> {
  authority = authority.toLowerCase();
  const promises = (vscode.workspace.workspaceFolders || []).map(workspaceFolder => {
    if (workspaceFolder.uri.authority.toLowerCase() !== authority) return;
    logging.info`Reloading workspace folder configs for '${authority}' connection`;
    return loadWorkspaceFolderConfigs(workspaceFolder);
  });
  if (!promises.length) return;
  await Promise.all(promises);
  applyConfigLayers();
}

vscode.workspace.onDidChangeConfiguration(async (e) => {
  if (e.affectsConfiguration('sshfs.configpaths')) {
    logging.info('Config paths changed for global/workspace, reloading configs...');
    return loadConfigs();
  }
  let updatedGlobal = e.affectsConfiguration('sshfs.configs');
  if (updatedGlobal) {
    logging.info('Config paths changed for global/workspace, updating layers...');
    await loadGlobalOrWorkspaceConfigs();
  }
  let updatedAtAll = updatedGlobal;
  for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
    if (updatedGlobal
      || e.affectsConfiguration('sshfs.configs', workspaceFolder)
      || e.affectsConfiguration('sshfs.configpaths', workspaceFolder)) {
      logging.info(`Configs and/or config paths changed for workspace folder ${workspaceFolder.uri}, updating layers...`);
      await loadWorkspaceFolderConfigs(workspaceFolder);
      updatedAtAll = true;
    }
  }
  if (updatedAtAll) applyConfigLayers();
});

vscode.workspace.onDidChangeWorkspaceFolders(event => {
  LOADING_CONFIGS = catchingPromise<FileSystemConfig[]>(async loaded => {
    logging.info('Workspace folders changed, recalculating configs with updated workspaceFolder configs...');
    event.removed.forEach(folder => configLayers.folder.delete(folder.uri.toString()));
    for (const folder of event.added) await loadWorkspaceFolderConfigs(folder);
    applyConfigLayers();
    loaded(loadedConfigs);
  }).catch(e => {
    logging.error`Error while reloading configs in onDidChangeWorkspaceFolders: ${e}`;
    return loadedConfigs;
  });
});

export type ConfigAlterer = (configs: FileSystemConfig[]) => FileSystemConfig[] | null | false;
export async function alterConfigs(location: ConfigLocation, alterer: ConfigAlterer) {
  let uri!: vscode.Uri | undefined;
  let prettyLocation: string | undefined;
  if (typeof location === 'string' && location.startsWith('WorkspaceFolder ')) {
    prettyLocation = location;
    uri = vscode.Uri.parse(location.substring(16));
    location = vscode.ConfigurationTarget.WorkspaceFolder;
  }
  switch (location) {
    case vscode.ConfigurationTarget.WorkspaceFolder:
      throw new Error(`Trying to update WorkspaceFolder settings with WorkspaceFolder Uri`);
    case vscode.ConfigurationTarget.Global:
      prettyLocation ||= 'Global';
    case vscode.ConfigurationTarget.Workspace:
      prettyLocation ||= 'Workspace';
      const conf = vscode.workspace.getConfiguration('sshfs', uri);
      const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
      // If the array doesn't exist, create a new empty one
      const array = inspect[[, 'globalValue', 'workspaceValue', 'workspaceFolderValue'][location]!] || [];
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
      logging.debug`\tUpdated configs in ${prettyLocation} Settings`;
      return;
  }
  if (typeof location !== 'string') throw new Error(`Invalid _location field: ${location}`);
  uri = vscode.Uri.parse(location, true);
  const configs = await readConfigFile(uri, true);
  if (!configs) {
    logging.error`Config file '${uri}' not found while altering configs'`;
    throw new Error(`Config file '${uri}' not found while altering configs'`);
  }
  let altered = alterer(configs);
  if (!altered) return;
  altered = altered.map((config) => {
    const newConfig = { ...config };
    for (const key in config) {
      if (key[0] === '_') delete newConfig[key];
    }
    return newConfig;
  });
  const data = Buffer.from(JSON.stringify(altered, null, 4));
  try { await fs.writeFile(uri, data); } catch (e) {
    logging.error`Error while writing configs to ${location}: ${e}`;
    throw e;
  }
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
