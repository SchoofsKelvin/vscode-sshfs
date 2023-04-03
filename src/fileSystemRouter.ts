import * as vscode from 'vscode';
import { getFlag, subscribeToGlobalFlags } from './flags';
import { Logging } from './logging';
import type { Manager } from './manager';

const ALL_DEBUG_FLAGS = [
  'stat', 'readDirectory', 'createDirectory',
  'readFile', 'writeFile', 'delete', 'rename',
].map(v => v.toLowerCase());

export class FileSystemRouter implements vscode.FileSystemProvider {
  public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  protected debugFlags: string[];
  constructor(protected readonly manager: Manager) {
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
    subscribeToGlobalFlags(() => {
      this.debugFlags = `${getFlag('DEBUG_FSR')?.[0] || ''}`.toLowerCase().split(/,\s*|\s+/g);
      if (this.debugFlags.includes('all')) this.debugFlags.push(...ALL_DEBUG_FLAGS);
    });
  }
  public async assertFs(uri: vscode.Uri): Promise<vscode.FileSystemProvider> {
    const fs = this.manager.getFs(uri);
    if (fs) return fs;
    return this.manager.createFileSystem(uri.authority);
  }
  /* FileSystemProvider */
  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // TODO: Store watched files/directories in an array and periodically check if they're modified
    /*let disp = () => {};
    assertFs(this, uri).then((fs) => {
      disp = fs.watch(uri, options).dispose.bind(fs);
    }).catch(console.error);
    return new vscode.Disposable(() => disp());*/
    return new vscode.Disposable(() => { });
  }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (this.debugFlags.includes('stat'))
      Logging.debug`Performing stat for ${uri}`;
    return (await this.assertFs(uri)).stat(uri);
  }
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    if (this.debugFlags.includes('readdirectory'))
      Logging.debug`Reading directory ${uri}`;
    return (await this.assertFs(uri)).readDirectory(uri);
  }
  public async createDirectory(uri: vscode.Uri): Promise<void> {
    if (this.debugFlags.includes('createdirectory'))
      Logging.debug`Creating directory ${uri}`;
    return (await this.assertFs(uri)).createDirectory(uri);
  }
  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (this.debugFlags.includes('readfile'))
      Logging.debug`Reading ${uri}`;
    return (await this.assertFs(uri)).readFile(uri);
  }
  public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
    if (this.debugFlags.includes('writefile'))
      Logging.debug`Writing ${content.length} bytes to ${uri} (options: ${options})`;
    return (await this.assertFs(uri)).writeFile(uri, content, options);
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
    if (this.debugFlags.includes('delete'))
      Logging.debug`Deleting ${uri} (options: ${options})`;
    return (await this.assertFs(uri)).delete(uri, options);
  }
  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
    if (this.debugFlags.includes('rename'))
      Logging.debug`Renaming ${oldUri} to ${newUri}`;
    const fs = await this.assertFs(oldUri);
    if (fs !== (await this.assertFs(newUri)))
      throw new Error(`Can't rename between different SSH filesystems`);
    return fs.rename(oldUri, newUri, options);
  }
}
