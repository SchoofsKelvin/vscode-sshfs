
import { readFile } from 'fs';
import { parse as parseJsonc, ParseError } from 'jsonc-parser';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Logging from './logging';
import { FileSystemConfig } from './manager';
import { toPromise } from './toPromise';

export const skippedConfigNames: string[] = [];

export function invalidConfigName(name: string) {
  if (!name) return 'Missing a name for this SSH FS';
  if (name.match(/^[\w_\\\/\.@\-+]+$/)) return null;
  return `A SSH FS name can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@`;
}

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
        Logging.warning(`Renamed unnamed config to ${config.name}`);
        okay = false;
      }
    });
    if (okay) return;
    return conf.update('configs', v, loc).then(() => { }, res => Logging.error(`Error while saving configs (CT=${loc}): ${res}`));
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
    Logging.error(`Error while reading ${location}: ${content.message}`);
    return [];
  }
  const errors: ParseError[] = [];
  const parsed: FileSystemConfig[] | null = parseJsonc(content.toString(), errors);
  if (!parsed || errors.length) {
    Logging.error(`Couldn't parse ${location} as a 'JSON with Comments' file`);
    vscode.window.showErrorMessage(`Couldn't parse ${location} as a 'JSON with Comments' file`);
    return [];
  }
  parsed.forEach(c => c._locations = [location]);
  Logging.debug(`Read ${parsed.length} configs from ${location}`);
  return parsed;
}

export async function loadConfigs() {
  Logging.info('Loading configurations...');
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
    layered.workspace.forEach(c => c._locations = ['Workspace']);
    layered.global.forEach(c => c._locations = ['Global']);
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
  const { workspaceFolders } = vscode.workspace;
  if (workspaceFolders) {
    for (const { uri } of workspaceFolders) {
      if (uri.scheme !== 'file') continue;
      const fConfig = vscode.workspace.getConfiguration('sshfs', uri).inspect<FileSystemConfig[]>('configs');
      const fConfigs = fConfig && fConfig.workspaceFolderValue || [];
      if (fConfigs.length) {
        Logging.debug(`Read ${fConfigs.length} configs from workspace folder ${uri}`);
        fConfigs.forEach(c => c._locations = [`WorkspaceFolder ${uri}`]);
      }
      layered.folder = [
        ...await readConfigFile(path.resolve(uri.fsPath, 'sshfs.json')),
        ...await readConfigFile(path.resolve(uri.fsPath, 'sshfs.jsonc')),
        ...fConfigs,
        ...layered.folder,
      ];
    }
  }
  // Start merging and cleaning up all configs
  const all = [...layered.folder, ...layered.workspace, ...layered.global];
  all.forEach(c => c.name = (c.name || '').toLowerCase()); // It being undefined shouldn't happen, but better be safe
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
        Logging.debug(`\tMerging duplicate ${conf.name} from ${conf._locations}`);
        dup._locations = [...dup._locations, ...conf._locations];
        Object.assign(dup, Object.assign(conf, dup));
      } else {
        Logging.debug(`\tIgnoring duplicate ${conf.name} from ${conf._locations}`);
      }
    } else {
      Logging.debug(`\tAdded configuration ${conf.name} from ${conf._locations}`);
      configs.push(conf);
    }
  }
  // Let the user do some cleaning
  for (const conf of configs) {
    if (!conf.name) {
      Logging.error(`Skipped an invalid SSH FS config (missing a name field):\n${JSON.stringify(conf, undefined, 4)}`);
      vscode.window.showErrorMessage(`Skipped an invalid SSH FS config (missing a name field)`);
    } else if (invalidConfigName(conf.name)) {
      if (skippedConfigNames.indexOf(conf.name) !== -1) continue;
      Logging.warning(`Found a SSH FS config with the invalid name "${conf.name}", prompting user how to handle`);
      vscode.window.showErrorMessage(`Invalid SSH FS config name: ${conf.name}`, 'Rename', 'Delete', 'Skip').then(async (answer) => {
        if (answer === 'Rename') {
          const name = await vscode.window.showInputBox({ prompt: `New name for: ${conf.name}`, validateInput: invalidConfigName, placeHolder: 'New name' });
          if (name) {
            const oldName = conf.name;
            Logging.info(`Renaming config "${oldName}" to "${name}"`);
            conf.name = name;
            return updateConfig(oldName, conf);
          }
        } else if (answer === 'Delete') {
          return updateConfig(conf.name);
        }
        skippedConfigNames.push(conf.name);
        Logging.warning(`Skipped SSH FS config '${conf.name}'`);
        vscode.window.showWarningMessage(`Skipped SSH FS config '${conf.name}'`);
      });
    }
  }
  loadedConfigs = configs.filter(c => !invalidConfigName(c.name));
  Logging.info(`Found ${loadedConfigs.length} configurations`);
  UPDATE_LISTENERS.forEach(listener => listener(loadedConfigs));
  return loadedConfigs;
}

export function getConfigLocation(name: string) {
  const conf = vscode.workspace.getConfiguration('sshfs');
  const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
  const contains = (v?: FileSystemConfig[]) => v && v.find(c => c.name === name);
  if (contains(inspect.workspaceFolderValue)) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (contains(inspect.workspaceValue)) {
    return vscode.ConfigurationTarget.Workspace;
  } else { // if (contains(inspect.globalValue)) {
    return vscode.ConfigurationTarget.Global;
  }
}

export async function updateConfig(name: string, config?: FileSystemConfig) {
  const conf = vscode.workspace.getConfiguration('sshfs');
  const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
  // const contains = (v?: FileSystemConfig[]) => v && v.find(c => c.name === name);
  const patch = (v: FileSystemConfig[]) => {
    const con = v.findIndex(c => c.name === name);
    if (!config) return v.filter(c => !c.name || c.name.toLowerCase() !== name);
    v[con === -1 ? v.length : con] = config;
    return v;
  };
  const loc = getConfigLocation(name);
  const array = [[], inspect.globalValue, inspect.workspaceValue, inspect.workspaceFolderValue][loc];
  await conf.update('configs', patch(array || []), loc || vscode.ConfigurationTarget.Global);
  Logging.debug(`Updated config "${name}"`);
  return loc;
}

export function getConfig(name: string) {
  if (name === '<config>') return null;
  return getConfigs().find(c => c.name === name);
}

export function openConfigurationEditor(name: string) {
  vscode.window.showTextDocument(vscode.Uri.parse(`ssh://<config>/${name}.sshfs.jsonc`), { preview: false });
}
