
import * as path from 'path';
import * as ssh2 from 'ssh2';
import * as ssh2s from 'ssh2-streams';
import * as vscode from 'vscode';
import { FileSystemConfig } from './fileSystemConfig';

export class SSHFileSystem implements vscode.FileSystemProvider {
  public waitForContinue = false;
  public closed = false;
  public closing = false;
  public copy = undefined;
  public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  constructor(public readonly authority: string, protected sftp: ssh2.SFTPWrapper,
              public readonly root: string, public readonly config: FileSystemConfig) {
    this.onDidChangeFile = this.onDidChangeFileEmitter.event;
    this.sftp.on('end', () => this.closed = true);
  }

  public disconnect() {
    this.closing = true;
    this.sftp.end();
  }

  public relative(relPath: string) {
    if (relPath.startsWith('/')) relPath = relPath.substr(1);
    return path.posix.resolve(this.root, relPath);
  }

  public continuePromise<T>(func: (cb: (err: Error | null, res?: T) => void) => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const exec = () => {
        this.waitForContinue = false;
        if (this.closed) return reject(new Error('Connection closed'));
        try {
          const canContinue = func((err, res) => err ? reject(err) : resolve(res));
          if (!canContinue) this.waitForContinue = true;
        } catch (e) {
          reject(e);
        }
      };
      if (this.waitForContinue) {
        this.sftp.once('continue', exec);
      } else {
        exec();
      }
    });
  }

  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // throw new Error('Method not implemented.');
    return new vscode.Disposable(() => { });
  }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await this.continuePromise<ssh2s.Stats>(cb => this.sftp.stat(this.relative(uri.path), cb)).catch((e: Error & { code: number }) => {
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
    const entries = await this.continuePromise<ssh2s.FileEntry[]>(cb => this.sftp.readdir(this.relative(uri.path), cb)).catch((e) => {
      throw e === 2 ? vscode.FileSystemError.FileNotFound(uri) : e;
    });
    return Promise.all(entries.map(async (file) => {
      const furi = uri.with({ path: `${uri.path}${uri.path.endsWith('/') ? '' : '/'}${file.filename}` });
      // Mode in octal representation is 120XXX for links, e.g. 120777
      // Any link's mode & 170000 should equal 120000 (using the octal system, at least)
      // tslint:disable-next-line:no-bitwise
      const link = (file.attrs.mode & 61440) === 40960 ? vscode.FileType.SymbolicLink : 0;
      try {
        const type = (await this.stat(furi)).type;
        // tslint:disable-next-line:no-bitwise
        return [file.filename, type | link] as [string, vscode.FileType];
      } catch (e) {
        // tslint:disable-next-line:no-bitwise
        return [file.filename, vscode.FileType.Unknown | link] as [string, vscode.FileType];
      }
    }));
  }
  public createDirectory(uri: vscode.Uri): void | Promise<void> {
    return this.continuePromise(cb => this.sftp.mkdir(this.relative(uri.path), cb));
  }
  public readFile(uri: vscode.Uri): Uint8Array | Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
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
      let mode: number | string | undefined;
      try {
        const stat = await this.continuePromise<ssh2s.Stats>(cb => this.sftp.stat(this.relative(uri.path), cb));
        mode = stat.mode;
      } catch (e) {
        if (e.message === 'No such file') {
          mode = this.config.newFileMode;
        } else {
          console.log(e);
          vscode.window.showWarningMessage(`Couldn't read the permissions for '${this.relative(uri.path)}', permissions might be overwritten`);
        }
      }
      mode = mode as number | undefined; // ssh2-streams supports an octal number as string, but ssh2's typings don't reflect this
      const stream = this.sftp.createWriteStream(this.relative(uri.path), { mode, flags: 'w' });
      stream.on('error', reject);
      stream.end(content, resolve);
    });
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<any> {
    const stats = await this.stat(uri);
    // tslint:disable no-bitwise */
    if (stats.type & (vscode.FileType.SymbolicLink | vscode.FileType.File)) {
      return this.continuePromise(cb => this.sftp.unlink(this.relative(uri.path), cb));
    } else if ((stats.type & vscode.FileType.Directory) && options.recursive) {
      return this.continuePromise(cb => this.sftp.rmdir(this.relative(uri.path), cb));
    }
    return this.continuePromise(cb => this.sftp.unlink(this.relative(uri.path), cb));
    // tslint:enable no-bitwise */
  }
  public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): void | Promise<void> {
    return this.continuePromise(cb => this.sftp.rename(this.relative(oldUri.path), this.relative(newUri.path), cb));
  }
}

export default SSHFileSystem;

export const EMPTY_FILE_SYSTEM = {
  onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
  watch: (uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }) => new vscode.Disposable(() => { }),
  stat: (uri: vscode.Uri) => ({ type: vscode.FileType.Unknown }) as vscode.FileStat,
  readDirectory: (uri: vscode.Uri) => [],
  createDirectory: (uri: vscode.Uri) => { },
  readFile: (uri: vscode.Uri) => new Uint8Array(0),
  writeFile: (uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }) => { },
  delete: (uri: vscode.Uri, options: { recursive: boolean; }) => { },
  rename: (oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) => { },
} as vscode.FileSystemProvider;
