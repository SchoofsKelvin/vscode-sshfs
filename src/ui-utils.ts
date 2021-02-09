
import * as vscode from 'vscode';
import { getConfigs } from './config';
import type { Connection } from './connection';
import { parseConnectionString, FileSystemConfig } from './fileSystemConfig';
import type { Manager } from './manager';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import type { SSHFileSystem } from './sshFileSystem';

export interface FormattedItem extends vscode.QuickPickItem, vscode.TreeItem {
    item: any;
    label: string;
    description?: string;
}

export function formatAddress(config: FileSystemConfig): string {
    const { username, host, port } = config;
    return `${username ? `${username}@` : ''}${host}${port ? `:${port}` : ''}`;
}

export let asAbsolutePath: vscode.ExtensionContext['asAbsolutePath'] | undefined;
export const setAsAbsolutePath = (value: typeof asAbsolutePath) => asAbsolutePath = value;

/** Converts the supported types to something basically ready-to-use as vscode.QuickPickItem and vscode.TreeItem */
export function formatItem(item: FileSystemConfig | Connection | SSHFileSystem | SSHPseudoTerminal, iconInLabel = false): FormattedItem {
    if ('handleInput' in item) { // SSHPseudoTerminal
        return {
            item, contextValue: 'terminal',
            label: `${iconInLabel ? '$(terminal) ' : ''}${item.terminal?.name || 'Unnamed terminal'}`,
            iconPath: new vscode.ThemeIcon('terminal'),
            command: {
                title: 'Focus',
                command: 'sshfs.focusTerminal',
                arguments: [item],
            },
        };
    } else if ('client' in item) { // Connection
        const { label, name, group } = item.config;
        const description = group ? `${group}.${name} ` : (label && name);
        const detail = formatAddress(item.actualConfig);
        return {
            item, description, detail, tooltip: detail,
            label: `${iconInLabel ? '$(plug) ' : ''}${label || name} `,
            iconPath: new vscode.ThemeIcon('plug'),
            contextValue: 'connection',
        };
    } else if ('onDidChangeFile' in item) { // SSHFileSystem
        return {
            item, description: item.root, contextValue: 'filesystem',
            label: `${iconInLabel ? '$(root-folder) ' : ''}ssh://${item.authority}/`,
            iconPath: asAbsolutePath?.('resources/icon.svg'),
        }
    }
    // FileSystemConfig
    const { label, name, group, putty } = item;
    const description = group ? `${group}.${name} ` : (label && name);
    const detail = putty === true ? 'PuTTY session (decuded from config)' :
        (typeof putty === 'string' ? `PuTTY session '${putty}'` : formatAddress(item));
    return {
        item: item, description, detail, tooltip: detail, contextValue: 'config',
        label: `${iconInLabel ? '$(settings-gear) ' : ''}${item.label || item.name} `,
        iconPath: new vscode.ThemeIcon('settings-gear'),
    }
}

type QuickPickItemWithItem = vscode.QuickPickItem & { item: any };

export interface PickComplexOptions {
    /** If true and there is only one or none item is available, immediately resolve with it/undefined */
    immediateReturn?: boolean;
    /** If true, add all connections. If this is a string, filter by config name first */
    promptConnections?: boolean | string;
    /** If true, add an option to enter a connection string */
    promptInstantConnection?: boolean;
    /** If true, add all configurations. If this is a string, filter by config name first */
    promptConfigs?: boolean | string;
    /** If true, add all terminals. If this is a string, filter by config name first */
    promptTerminals?: boolean | string;
    /** If set, filter the connections/configs by (config) name first */
    nameFilter?: string;
}

async function inputInstantConnection(): Promise<FileSystemConfig | undefined> {
    const name = await vscode.window.showInputBox({
        placeHolder: 'user@host:/home/user',
        prompt: 'SSH connection string',
        validateInput(value: string) {
            const result = parseConnectionString(value);
            return typeof result === 'string' ? result : undefined;
        }
    });
    if (!name) return;
    const result = parseConnectionString(name);
    if (typeof result === 'string') return;
    return result[0];
}

export async function pickComplex(manager: Manager, options: PickComplexOptions):
    Promise<FileSystemConfig | Connection | SSHPseudoTerminal | undefined> {
    return new Promise<any>((resolve) => {
        const { promptConnections, promptConfigs, nameFilter } = options;
        const items: QuickPickItemWithItem[] = [];
        const toSelect: string[] = [];
        if (promptConnections) {
            let cons = manager.connectionManager.getActiveConnections();
            if (typeof promptConnections === 'string') cons = cons.filter(con => con.actualConfig.name === promptConnections);
            if (nameFilter) cons = cons.filter(con => con.actualConfig.name === nameFilter);
            items.push(...cons.map(con => formatItem(con, true)));
            toSelect.push('connection');
        }
        if (promptConfigs) {
            let configs = getConfigs();
            if (typeof promptConfigs === 'string') configs = configs.filter(config => config.name === promptConfigs);
            if (nameFilter) configs = configs.filter(config => config.name === nameFilter);
            items.push(...configs.map(config => formatItem(config, true)));
            toSelect.push('configuration');
        }
        if (options.promptTerminals) {
            let cons = manager.connectionManager.getActiveConnections();
            if (typeof promptConnections === 'string') cons = cons.filter(con => con.actualConfig.name === promptConnections);
            if (nameFilter) cons = cons.filter(con => con.actualConfig.name === nameFilter);
            const terminals = cons.reduce((all, con) => [...all, ...con.terminals], []);
            items.push(...terminals.map(config => formatItem(config, true)));
            toSelect.push('terminal');
        }
        if (options.promptInstantConnection) {
            items.unshift({
                label: '$(terminal) Create instant connection',
                detail: 'Opens an input box where you can type e.g. `user@host:/home/user`',
                picked: true, alwaysShow: true,
                item: inputInstantConnection,
            });
        }
        if (options.immediateReturn && items.length <= 1) return resolve(items[0]?.item);
        const quickPick = vscode.window.createQuickPick<QuickPickItemWithItem>();
        quickPick.items = items;
        quickPick.title = 'Select ' + toSelect.join(' / ');
        quickPick.onDidAccept(() => {
            const value = quickPick.activeItems[0]?.item;
            quickPick.hide();
            resolve(value);
        });
        quickPick.onDidHide(() => resolve());
        quickPick.show();
    }).then(result => typeof result === 'function' ? result() : result);
}

export const pickConfig = (manager: Manager) => pickComplex(manager, { promptConfigs: true }) as Promise<FileSystemConfig | undefined>;
export const pickConnection = (manager: Manager, name?: string) =>
    pickComplex(manager, { promptConnections: name || true, immediateReturn: !!name }) as Promise<Connection | undefined>;
export const pickTerminal = (manager: Manager) => pickComplex(manager, { promptTerminals: true }) as Promise<SSHPseudoTerminal | undefined>;
