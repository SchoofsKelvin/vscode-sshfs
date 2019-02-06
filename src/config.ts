
import * as vscode from 'vscode';
import * as Logging from './logging';
import { FileSystemConfig } from './manager';

export const skippedConfigNames: string[] = [];

export function invalidConfigName(name: string) {
  if (!name) return 'Missing a name for this SSH FS';
  if (name.match(/^[\w_\\\/\.@\-+]+$/)) return null;
  return `A SSH FS name can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@`;
}

function randomAvailableName(index = 0): [string, number] {
  let name = index ? `unnamed${index}` : 'unnamed';
  while (loadConfigs(true).find(c => c.name === name)) {
    index += 1;
    name = `unnamed${index}`;
  }
  return [name, index + 1];
}

export async function renameNameless() {
  const conf = vscode.workspace.getConfiguration('sshfs');
  const inspect = conf.inspect<FileSystemConfig[]>('configs')!;
  let randomIndex = 0;
  const patch = (v?: FileSystemConfig[]) => {
    if (v) {
      v.forEach((config) => {
        if (!config.name) {
          [config.name, randomIndex] = randomAvailableName(randomIndex);
          Logging.warning(`Renamed unnamed config to ${config.name}`);
        }
      });
    }
    return v;
  };
  await conf.update('configs', patch(inspect.globalValue), vscode.ConfigurationTarget.Global).then(() => { }, () => { });
  await conf.update('configs', patch(inspect.workspaceValue), vscode.ConfigurationTarget.Workspace).then(() => { }, () => { });
  await conf.update('configs', patch(inspect.workspaceFolderValue), vscode.ConfigurationTarget.WorkspaceFolder).then(() => { }, () => { });
}

export function loadConfigs(raw = false) {
  const config = vscode.workspace.getConfiguration('sshfs');
  if (!config) return [];
  const inspect = config.inspect<FileSystemConfig[]>('configs')!;
  let configs: FileSystemConfig[] = [
    ...(inspect.workspaceFolderValue || []),
    ...(inspect.workspaceValue || []),
    ...(inspect.globalValue || []),
  ];
  configs.forEach(c => c.name = (c.name || '').toLowerCase());
  configs = configs.filter((c, i) => configs.findIndex(c2 => c2.name === c.name) === i);
  if (raw) return configs;
  renameNameless();
  for (const conf of configs) {
    if (!conf.name) {
      Logging.error(`Skipped an invalid SSH FS config (missing a name field):\n${JSON.stringify(conf, undefined, 4)}`);
      vscode.window.showErrorMessage(`Skipped an invalid SSH FS config (missing a name field)`);
    } else if (invalidConfigName(conf.name)) {
      if (skippedConfigNames.indexOf(conf.name) !== -1) continue;
      Logging.error(`Found a SSH FS config with the invalid name "${conf.name}", prompting user how to handle`);
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
  return configs.filter(c => !invalidConfigName(c.name));
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
  return loadConfigs().find(c => c.name === name);
}

export function openConfigurationEditor(name: string) {
  vscode.window.showTextDocument(vscode.Uri.parse(`ssh://<config>/${name}.sshfs.jsonc`), { preview: false });
}
