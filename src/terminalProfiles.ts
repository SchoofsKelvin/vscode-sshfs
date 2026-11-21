import type { FileSystemConfig } from 'common/fileSystemConfig';
import { existsSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import type { Connection } from './connection';
import { Logging } from './logging';
import type { Manager } from './manager';
import { pickComplex } from './ui-utils';

/*
 * Terminal profiles, listed in the dropdown of the "+" button of the terminal panel (see `contributes.terminal.profiles`):
 * - "New Terminal in connected SSH host": opens a terminal on the SSH host of the workspace straight away (in the SSH
 *   workspace folder of the active editor, or the first SSH workspace folder, or else the first active connection).
 *   Falls back to a terminal on this computer when there is no such host. Made the default profile (thus what the "+"
 *   button and "Terminal: Create New Terminal" open) unless `sshfs.terminal.defaultToConnectedHost` is disabled
 * - "Open remote SSH terminal": asks where to open the terminal: "New Terminal in <name>" for every SSH workspace folder
 *   and active connection, "New Terminal (this computer)", or any other host
 * - "New Terminal (this computer)": a terminal using the local shell, for when the remote one is the default
 *
 * VS Code doesn't allow extensions to add items with dynamic titles (e.g. one per connection) to that dropdown,
 * nor does it have an API to pick the default profile, hence the fixed titles and the `defaultProfile` setting.
 */

export const TERMINAL_PROFILE_CONNECTED = 'sshfs.terminalProfile.connected';
export const TERMINAL_PROFILE_PICK = 'sshfs.terminalProfile';
export const TERMINAL_PROFILE_LOCAL = 'sshfs.terminalProfile.local';
/** Title of the {@link TERMINAL_PROFILE_CONNECTED} profile in package.json, `terminal.integrated.defaultProfile.*` refers to profiles by title */
export const TERMINAL_PROFILE_CONNECTED_TITLE = 'New Terminal in connected SSH host';
/** Where we remember the default profile we replaced, to use it for local terminals and to restore it */
const PREVIOUS_DEFAULT_KEY = 'previousDefaultTerminalProfile';

export interface TerminalTarget {
  target: FileSystemConfig | Connection;
  /** The (`ssh://`) folder to start the terminal in, if not the root of the config */
  uri?: vscode.Uri;
  /** Display name of the connection: the label or name of the config */
  name: string;
}

/** The SSH workspace folders, the one of the active editor first */
function sshWorkspaceFolders(): vscode.WorkspaceFolder[] {
  const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'ssh');
  const active = vscode.window.activeTextEditor?.document.uri;
  const current = active?.scheme === 'ssh' ? folders.find(folder => folder.uri.authority === active.authority
    && (active.path === folder.uri.path || active.path.startsWith(folder.uri.path.replace(/\/?$/, '/')))) : undefined;
  return current ? [current, ...folders.filter(folder => folder !== current)] : folders;
}

/** Where a new remote terminal can be opened: the SSH workspace folders (active editor's first), then the other active connections */
export function getConnectedTargets(manager: Manager): TerminalTarget[] {
  const connections = manager.connectionManager.getActiveConnections();
  const targets: TerminalTarget[] = [];
  const seen = new Set<string>();
  for (const folder of sshWorkspaceFolders()) {
    const name = folder.uri.authority.toLowerCase();
    // Reuse the connection of the workspace folder, or connect like opening the workspace folder would
    const con = connections.find(con => con.actualConfig.name.toLowerCase() === name);
    const config = con?.actualConfig || getConfig(name);
    if (!config) {
      Logging.warning(`No configuration found for workspace folder ${folder.uri}, can't open a terminal for it`);
      continue;
    }
    seen.add(config.name.toLowerCase());
    targets.push({ target: con || config, uri: folder.uri, name: config.label || config.name });
  }
  for (const con of connections) {
    const config = con.actualConfig;
    if (seen.has(config.name.toLowerCase())) continue;
    seen.add(config.name.toLowerCase());
    targets.push({ target: con, name: config.label || config.name });
  }
  return targets;
}

function platformKey(): 'windows' | 'osx' | 'linux' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

interface ShellProfileSetting {
  path?: string | string[];
  args?: string | string[];
  env?: Record<string, string | null>;
}

/** A terminal on this computer: the default profile we replaced (if it's a plain shell), otherwise the default shell */
export function getLocalTerminalProfile(context: vscode.ExtensionContext): vscode.TerminalProfile {
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  const previous = context.globalState.get<string>(PREVIOUS_DEFAULT_KEY);
  const profiles = terminalConfig.get<Record<string, ShellProfileSetting | null>>(`profiles.${platformKey()}`) || {};
  const options: vscode.TerminalOptions = {};
  const setting = previous ? profiles[previous] : undefined;
  const paths = setting?.path ? (Array.isArray(setting.path) ? setting.path : [setting.path]) : [];
  const shellPath = paths.find(p => path.isAbsolute(p) ? existsSync(p) : true);
  if (shellPath) {
    options.name = previous;
    options.shellPath = shellPath;
    if (setting?.args) options.shellArgs = setting.args;
    if (setting?.env) options.env = setting.env;
  } else {
    // Note that VS Code bases vscode.env.shell on the default profile, which might be ours (it falls back to the system shell then)
    const candidates = [vscode.env.shell, process.platform === 'win32' ? process.env.ComSpec : process.env.SHELL];
    options.shellPath = candidates.find(p => p && (!path.isAbsolute(p) || existsSync(p)))
      || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
  }
  // Like VS Code itself: start in the (first) local workspace folder, otherwise the home directory
  options.cwd = (vscode.workspace.workspaceFolders || []).find(folder => folder.uri.scheme === 'file')?.uri || homedir();
  return new vscode.TerminalProfile(options);
}

interface TerminalPickItem extends vscode.QuickPickItem {
  action: 'target' | 'local' | 'other';
  target?: TerminalTarget;
}

/**
 * Makes "New Terminal in connected SSH host" the default terminal profile (in the user settings), remembering the
 * previous default. Disabling `sshfs.terminal.defaultToConnectedHost` puts the previous default back.
 */
async function updateDefaultTerminalProfile(context: vscode.ExtensionContext): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('sshfs').get<boolean>('terminal.defaultToConnectedHost', true);
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  const key = `defaultProfile.${platformKey()}`;
  const current = terminalConfig.inspect<string>(key)?.globalValue;
  if (enabled && current !== TERMINAL_PROFILE_CONNECTED_TITLE) {
    await context.globalState.update(PREVIOUS_DEFAULT_KEY, current);
    await terminalConfig.update(key, TERMINAL_PROFILE_CONNECTED_TITLE, vscode.ConfigurationTarget.Global);
    Logging.info`Made "${TERMINAL_PROFILE_CONNECTED_TITLE}" the default terminal profile (terminal.integrated.${key}, was ${current || 'not set'})`;
  } else if (!enabled && current === TERMINAL_PROFILE_CONNECTED_TITLE) {
    const previous = context.globalState.get<string>(PREVIOUS_DEFAULT_KEY);
    await terminalConfig.update(key, previous, vscode.ConfigurationTarget.Global);
    Logging.info`Restored the default terminal profile (terminal.integrated.${key}) to ${previous || 'not set'}`;
  }
}

/** Never resolves: VS Code shows an error notification if a profile provider doesn't return a profile, which isn't wanted when e.g. a picker got dismissed */
const nothing = () => new Promise<never>(() => { });

export function registerTerminalProfiles(context: vscode.ExtensionContext, manager: Manager): void {
  const open = async (target: TerminalTarget) => await manager.createTerminalProfile(target.target, target.uri) || nothing();
  const providers: [id: string, provider: vscode.TerminalProfileProvider][] = [
    [TERMINAL_PROFILE_CONNECTED, {
      async provideTerminalProfile() {
        const [target] = getConnectedTargets(manager);
        if (target) return open(target);
        Logging.debug`No connected SSH host to open a terminal for, opening a terminal on this computer instead`;
        return getLocalTerminalProfile(context);
      },
    }],
    [TERMINAL_PROFILE_PICK, {
      async provideTerminalProfile() {
        const items: TerminalPickItem[] = getConnectedTargets(manager).map(target => ({
          label: `$(remote) New Terminal in ${target.name}`,
          description: target.uri ? target.uri.path : 'active connection',
          action: 'target', target,
        }));
        items.push({ label: '$(device-desktop) New Terminal (this computer)', action: 'local' });
        items.push({ label: '$(plug) Other host or connection...', action: 'other' });
        const picked = await vscode.window.showQuickPick(items, { title: 'Open remote SSH terminal', placeHolder: 'Where to open the new terminal' });
        if (!picked) return nothing();
        if (picked.action === 'target') return open(picked.target!);
        if (picked.action === 'local') return getLocalTerminalProfile(context);
        const target = await pickComplex(manager, { promptConfigs: true, promptConnections: true, promptInstantConnection: true });
        if (!target || 'handleInput' in target) return nothing();
        return await manager.createTerminalProfile(target) || nothing();
      },
    }],
    [TERMINAL_PROFILE_LOCAL, { provideTerminalProfile: () => getLocalTerminalProfile(context) }],
  ];
  for (const [id, provider] of providers) {
    try {
      context.subscriptions.push(vscode.window.registerTerminalProfileProvider(id, provider));
    } catch (e) {
      // VS Code throws if another extension (e.g. another copy of SSH FS) already registered this terminal profile.
      // That shouldn't prevent registering everything else (commands, when clause contexts, ...)
      Logging.error`Could not register the terminal profile ${id}: ${e}`;
    }
  }
  const update = () => updateDefaultTerminalProfile(context).catch(e => Logging.error`Could not update the default terminal profile: ${e}`);
  update();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('sshfs.terminal.defaultToConnectedHost')) update();
  }));
}
