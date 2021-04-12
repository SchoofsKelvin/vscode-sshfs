
import * as vscode from 'vscode';
import { getConfigs } from './config';
import type { Connection } from './connection';
import { FileSystemConfig, parseConnectionString } from './fileSystemConfig';
import type { Manager } from './manager';
import { ActivePortForwarding, isActivePortForwarding } from './portForwarding';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import type { SSHFileSystem } from './sshFileSystem';
import { toPromise } from './toPromise';

export interface FormattedItem extends vscode.QuickPickItem, vscode.TreeItem {
    item: any;
    label: string;
    description?: string;
}

export function formatAddress(config: FileSystemConfig): string {
    const { username, host, port } = config;
    return `${username ? `${username}@` : ''}${host}${port ? `:${port}` : ''}`;
}

export const capitalize = (str: string) => str.substring(0, 1).toUpperCase() + str.substring(1);

export let asAbsolutePath: vscode.ExtensionContext['asAbsolutePath'] | undefined;
export const setAsAbsolutePath = (value: typeof asAbsolutePath) => asAbsolutePath = value;

/** Converts the supported types to something basically ready-to-use as vscode.QuickPickItem and vscode.TreeItem */
export function formatItem(item: FileSystemConfig | Connection | SSHFileSystem | SSHPseudoTerminal | ActivePortForwarding, iconInLabel = false): FormattedItem {
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
            collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
            contextValue: 'connection',
        };
    } else if ('onDidChangeFile' in item) { // SSHFileSystem
        return {
            item, description: item.root, contextValue: 'filesystem',
            label: `${iconInLabel ? '$(root-folder) ' : ''}ssh://${item.authority}/`,
            iconPath: asAbsolutePath?.('resources/icon.svg'),
        }
    } else if (isActivePortForwarding(item)) {
        let label = iconInLabel ? '$(ports-forward-icon) ' : '';
        const [forw] = item;
        if (forw.type === 'local' || forw.type === 'remote') {
            label += forw.localPort === undefined ? forw.localAddress : `${forw.localAddress || '?'}:${forw.localPort}` || '?';
            label += forw.type === 'local' ? ' → ' : ' ← ';
            label += forw.remotePort === undefined ? forw.remoteAddress : `${forw.remoteAddress || '?'}:${forw.remotePort}` || '?';
        } else if (forw.type === 'dynamic') {
            label += `${forw.address || '?'}:${forw.port} $(globe)`;
        } else {
            label += ' <unrecognized type>';
        }
        const connLabel = item[1].actualConfig.label || item[1].actualConfig.name;
        const detail = `${capitalize(forw.type)} port forwarding to ${connLabel}`
        return {
            item, label, contextValue: 'forwarding',
            detail, tooltip: detail,
            iconPath: new vscode.ThemeIcon('ports-forward-icon'),
        };
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
    /** If true, add all active port forwardings. If this is a string, filter by address/port first */
    promptActivePortForwardings?: boolean | string;
    /** If set, filter the connections/configs by (config) name first */
    nameFilter?: string;
}

async function inputInstantConnection(value?: string): Promise<FileSystemConfig | undefined> {
    const valueSelection = value ? [value.length, value.length] as [number, number] : undefined;
    const name = await vscode.window.showInputBox({
        value, valueSelection,
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
        if (options.promptActivePortForwardings) {
            let cons = manager.connectionManager.getActiveConnections();
            if (typeof promptConnections === 'string') cons = cons.filter(con => con.actualConfig.name === promptConnections);
            if (nameFilter) cons = cons.filter(con => con.actualConfig.name === nameFilter);
            const forwardings = cons.reduce((all, con) => [...all, ...con.forwardings], []);
            items.push(...forwardings.map(config => formatItem(config, true)));
            toSelect.push('forwarded port');
        }
        if (options.promptInstantConnection) {
            items.unshift({
                label: '$(terminal) Create instant connection',
                detail: 'Opens an input box where you can type e.g. `user@host:22/home/user`',
                picked: true, alwaysShow: true,
                item: inputInstantConnection,
            });
        }
        if (options.immediateReturn && items.length <= 1) return resolve(items[0]?.item);
        const quickPick = vscode.window.createQuickPick<QuickPickItemWithItem>();
        quickPick.items = items;
        quickPick.title = 'Select ' + toSelect.join(' / ');
        quickPick.onDidAccept(() => {
            let value = quickPick.activeItems[0]?.item;
            quickPick.hide();
            if (typeof value === 'function') {
                value = value(quickPick.value);
            }
            resolve(value);
        });
        quickPick.onDidHide(() => resolve(undefined));
        quickPick.show();
    });
}

export const pickConfig = (manager: Manager) => pickComplex(manager, { promptConfigs: true }) as Promise<FileSystemConfig | undefined>;
export const pickConnection = (manager: Manager, name?: string) =>
    pickComplex(manager, { promptConnections: name || true, immediateReturn: !!name }) as Promise<Connection | undefined>;
export const pickTerminal = (manager: Manager) => pickComplex(manager, { promptTerminals: true }) as Promise<SSHPseudoTerminal | undefined>;

export async function promptQuickPick<T>(title: string, items: readonly T[], toString?: (item: T) => string): Promise<T | undefined> {
    const picker = vscode.window.createQuickPick<FormattedItem>();
    picker.title = title;
    picker.items = items.map(item => ({ item, label: toString?.(item) || `${item}` }));
    picker.show();
    const accepted = await Promise.race([
        toPromise(cb => picker.onDidAccept(cb)).then(() => true),
        toPromise(cb => picker.onDidHide(cb)).then(() => false),
    ]);
    if (!accepted) return undefined;
    return picker.selectedItems[0]?.item;
}
