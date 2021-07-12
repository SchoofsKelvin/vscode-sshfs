import * as vscode from 'vscode';
import { Logging } from './logging';
import type { Manager } from './manager';

function isWorkspaceStale(uri: vscode.Uri) {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (folder.uri.scheme !== 'ssh') continue;
    if (folder.uri.authority === uri.authority) return false;
  }
  return true;
}

export class FileSystemRouter implements vscode.FileSystemProvider {
  public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  constructor(protected readonly manager: Manager) {
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
  }
  public async assertFs(uri: vscode.Uri): Promise<vscode.FileSystemProvider> {
    const fs = this.manager.getFs(uri);
    if (fs) return fs;
    // There are some edge cases where vscode tries to access files of a WorkspaceFolder
    // that's (being) removed, or it's being added but the window is supposed to reload.
    // We only check the first case here
    if (isWorkspaceStale(uri)) {
      Logging.warning(`Stale workspace for '${uri}', returning empty file system`);
      // Throwing an error gives the "${root} · Can not resolve workspace folder"
      // throw vscode.FileSystemError.Unavailable('Stale workspace');
      // So let's just act as if everything's fine, but there's only the void.
      return (await import('./sshFileSystem')).EMPTY_FILE_SYSTEM;
    }
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
    return (await this.assertFs(uri)).stat(uri);
  }
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return (await this.assertFs(uri)).readDirectory(uri);
  }
  public async createDirectory(uri: vscode.Uri): Promise<void> {
    return (await this.assertFs(uri)).createDirectory(uri);
  }
  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    Logging.debug(`Reading ${uri}`);
    return (await this.assertFs(uri)).readFile(uri);
  }
  public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
    Logging.debug(`Writing ${content.length} bytes to ${uri}`);
    return (await this.assertFs(uri)).writeFile(uri, content, options);
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
    Logging.debug(`Deleting ${uri}`);
    return (await this.assertFs(uri)).delete(uri, options);
  }
  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
    Logging.debug(`Renaming ${oldUri} to ${newUri}`);
    const fs = await this.assertFs(oldUri);
    if (fs !== (await this.assertFs(newUri))) throw new Error(`Can't rename between different SSH filesystems`);
    return fs.rename(oldUri, newUri, options);
  }
}
