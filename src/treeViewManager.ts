
import { FileSystemConfig, getGroups } from 'common/fileSystemConfig';
import * as vscode from 'vscode';
import { getConfigs, UPDATE_LISTENERS } from './config';
import type { Connection, ConnectionManager } from './connection';
import type { SSHPseudoTerminal } from './pseudoTerminal';
import type { SSHFileSystem } from './sshFileSystem';
import { formatItem } from './ui-utils';

type PendingConnection = [string, FileSystemConfig | undefined];
type TreeData = Connection | PendingConnection | SSHFileSystem | SSHPseudoTerminal;
export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeData> {
    protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeData | void>();
    public onDidChangeTreeData: vscode.Event<TreeData | void> = this.onDidChangeTreeDataEmitter.event;
    constructor(protected readonly manager: ConnectionManager) {
        manager.onConnectionAdded(() => this.onDidChangeTreeDataEmitter.fire());
        manager.onConnectionRemoved(() => this.onDidChangeTreeDataEmitter.fire());
        manager.onConnectionUpdated(con => this.onDidChangeTreeDataEmitter.fire(con));
    }
    public refresh() {
        this.onDidChangeTreeDataEmitter.fire();
    }
    public getTreeItem(element: TreeData): vscode.TreeItem | Thenable<vscode.TreeItem> {
        if ('onDidChangeFile' in element || 'handleInput' in element) { // SSHFileSystem | SSHPseudoTerminal
            return { ...formatItem(element), collapsibleState: vscode.TreeItemCollapsibleState.None }
        } else if (Array.isArray(element)) { // PendingConnection
            const [name, config] = element;
            if (!config) return { label: name, description: 'Connecting...' };
            return {
                ...formatItem(config),
                contextValue: 'pendingconnection',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                // Doesn't seem to actually spin, but still gets rendered properly otherwise
                iconPath: new vscode.ThemeIcon('loading~spin'),
            };
        }
        // Connection
        return { ...formatItem(element), collapsibleState: vscode.TreeItemCollapsibleState.Collapsed };
    }
    public getChildren(element?: TreeData): vscode.ProviderResult<TreeData[]> {
        if (!element) return [
            ...this.manager.getActiveConnections(),
            ...this.manager.getPendingConnections(),
        ];
        if ('onDidChangeFile' in element) return []; // SSHFileSystem
        if ('handleInput' in element) return []; // SSHPseudoTerminal
        if (Array.isArray(element)) return []; // PendingConnection
        return [...element.terminals, ...element.filesystems]; // Connection
    }
}

export class ConfigTreeProvider implements vscode.TreeDataProvider<FileSystemConfig | string> {
    protected onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileSystemConfig | string | void>();
    public onDidChangeTreeData: vscode.Event<FileSystemConfig | string | void> = this.onDidChangeTreeDataEmitter.event;
    constructor() {
        // Would be very difficult (and a bit useless) to pinpoint the exact
        // group/config that changes, so let's just update the whole tree
        UPDATE_LISTENERS.push(() => this.onDidChangeTreeDataEmitter.fire());
        // ^ Technically a memory leak, but there should only be one ConfigTreeProvider that never gets discarded
    }
    public getTreeItem(element: FileSystemConfig | string): vscode.TreeItem | Thenable<vscode.TreeItem> {
        if (typeof element === 'string') {
            return {
                label: element.replace(/^.+\./, ''), contextValue: 'group',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                iconPath: vscode.ThemeIcon.Folder,
            };
        }
        return { ...formatItem(element), collapsibleState: vscode.TreeItemCollapsibleState.None };
    }
    public getChildren(element: FileSystemConfig | string = ''): vscode.ProviderResult<(FileSystemConfig | string)[]> {
        if (typeof element !== 'string') return []; // Configs don't have children
        const configs = getConfigs();
        const matching = configs.filter(({ group }) => (group || '') === element);
        matching.sort((a, b) => a.name > b.name ? 1 : -1);
        let groups = getGroups(configs, true);
        if (element) {
            groups = groups.filter(g => g.startsWith(element) && g[element.length] === '.' && !g.includes('.', element.length + 1));
        } else {
            groups = groups.filter(g => !g.includes('.'));
        }
        return [...matching, ...groups.sort()];
    }
}