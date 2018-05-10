
import * as path from 'path';
import * as ssh2 from 'ssh2';
import * as ssh2s from 'ssh2-streams';
import * as vscode from 'vscode';
import { FileSystemConfig } from './manager';
import { toPromise } from './toPromise';

export class SSHFileSystem implements vscode.FileSystemProvider {
  public copy = undefined;
  public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  constructor(public readonly authority: string, protected sftp: ssh2.SFTPWrapper,
              public readonly root: string, public readonly config: FileSystemConfig) {
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
  }

  public disconnect() {
    this.sftp.end();
  }

  public relative(relPath: string) {
    if (relPath.startsWith('/')) relPath = relPath.substr(1);
    return path.posix.resolve(this.root, relPath);
  }

  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // throw new Error('Method not implemented.');
    return new vscode.Disposable(() => { });
  }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await toPromise<ssh2s.Stats>(cb => this.sftp.stat(this.relative(uri.path), cb)).catch((e: Error & { code: number }) => {
      throw e.code === 2 ? vscode.FileSystemError.FileNotFound(uri) : e;
    });
    const { mtime, size } = stat;
    let type = vscode.FileType.Unknown;
    // tslint:disable no-bitwise */
    if (stat.isFile()) type = type | vscode.FileType.File;
    if (stat.isDirectory()) type = type | vscode.FileType.Directory;
    if (stat.isSymbolicLink()) type = type | vscode.FileType.SymbolicLink;
    // tslint:enable no-bitwise */
    return {
      type, mtime, size,
      ctime: 0,
    };
  }
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await toPromise<ssh2s.FileEntry[]>(cb => this.sftp.readdir(this.relative(uri.path), cb)).catch((e) => {
      throw e === 2 ? vscode.FileSystemError.FileNotFound(uri) : e;
    });
    return Promise.all(entries.map(async (file) => {
      const furi = uri.with({ path: `${uri.path}${uri.path.endsWith('/') ? '' : '/'}${file.filename}` });
      const type = (await this.stat(furi)).type;
      return [file.filename, type] as [string, vscode.FileType];
    }));
  }
  public createDirectory(uri: vscode.Uri): void | Promise<void> {
    return toPromise(cb => this.sftp.mkdir(this.relative(uri.path), cb));
  }
  public readFile(uri: vscode.Uri): Uint8Array | Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const array = new Buffer(0);
      const stream = this.sftp.createReadStream(this.relative(uri.path), { autoClose: true });
      const bufs = [];
      stream.on('data', bufs.push.bind(bufs));
      stream.on('error', reject);
      stream.on('close', () => {
        resolve(new Uint8Array(Buffer.concat(bufs)));
      });
    });
  }
  public writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Promise<void> {
    return new Promise(async (resolve, reject) => {
      let mode: number | undefined;
      try {
        const stat = await toPromise<ssh2s.Stats>(cb => this.sftp.stat(this.relative(uri.path), cb));
        mode = stat.mode;
      } catch (e) {
        if (e.message !== 'No such file') {
          console.log(e);
          vscode.window.showWarningMessage(`Couldn't read the permissions for '${this.relative(uri.path)}', permissions might be overwritten`);
        }
      }
      const array = new Buffer(0);
      const stream = this.sftp.createWriteStream(this.relative(uri.path), { mode, flags: 'w' });
      stream.on('error', reject);
      stream.end(content, resolve);
    });
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<any> {
    const stats = await this.stat(uri);
    // tslint:disable no-bitwise */
    if (stats.type & (vscode.FileType.SymbolicLink | vscode.FileType.File)) {
      return toPromise(cb => this.sftp.unlink(this.relative(uri.path), cb));
    } else if ((stats.type & vscode.FileType.Directory) && options.recursive) {
      return toPromise(cb => this.sftp.rmdir(this.relative(uri.path), cb));
    }
    return toPromise(cb => this.sftp.unlink(this.relative(uri.path), cb));
    // tslint:enable no-bitwise */
  }
  public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): void | Promise<void> {
    return toPromise(cb => this.sftp.rename(this.relative(oldUri.path), this.relative(newUri.path), cb));
  }
}

export default SSHFileSystem;

export const EMPTY_FILE_SYSTEM = {
  onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
  watch: (uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }) => new vscode.Disposable(() => {}),
  stat: (uri: vscode.Uri) => ({ type: vscode.FileType.Unknown }) as vscode.FileStat,
  readDirectory: (uri: vscode.Uri) => [],
  createDirectory: (uri: vscode.Uri) => {},
  readFile: (uri: vscode.Uri) => new Uint8Array(0),
  writeFile: (uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }) => {},
  delete: (uri: vscode.Uri, options: { recursive: boolean; }) => {},
  rename: (oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) => {},
} as vscode.FileSystemProvider;
