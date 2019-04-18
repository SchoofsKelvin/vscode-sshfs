import * as vscode from 'vscode';
import * as Logging from './logging';
import { Manager } from './manager';

const FOLDERS = vscode.workspace.workspaceFolders!;
function isWorkspaceStale() {
  const FOLDERS2 = vscode.workspace.workspaceFolders!;
  if (!FOLDERS !== !FOLDERS2) return true;
  // Both should exist here, but checking both for typechecking
  if (!FOLDERS.length !== !FOLDERS2.length) return true;
  const [folder1] = FOLDERS;
  const [folder2] = FOLDERS2;
  if (folder1 === folder2) return false;
  const { name: name1, uri: uri1 } = folder1;
  const { name: name2, uri: uri2 } = folder2;
  if (name1 !== name2) return true;
  if (uri1.toString() !== uri2.toString()) return true;
  return false;
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
    // When adding one of our filesystems as the first workspace folder,
    // it's possible (and even likely) that vscode will set
    // vscode.workspace.workspaceFolders and prompt our filesystem
    // for .vscode/settings.json, right before extensions get reloaded.
    // This triggers a useless connection (and password prompting), so
    // if we detect here the workspace is in a phase of change, resulting
    // in extensions reload, just throw an error. vscode is fine with it.
    if (isWorkspaceStale()) {
      console.error('Stale workspace');
      // Throwing an error gives the "${root} · Can not resolve workspace folder"
      // throw vscode.FileSystemError.Unavailable('Stale workspace');
      // So let's just act as if everything's fine, but there's only the void.
      // The extensions (and FileSystemProviders) get reloaded soon anyway.
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
