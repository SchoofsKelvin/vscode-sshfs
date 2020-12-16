
import * as path from 'path';
import type * as ssh2 from 'ssh2';
import type * as ssh2s from 'ssh2-streams';
import * as vscode from 'vscode';
import { FileSystemConfig } from './fileSystemConfig';
import { Logger, Logging, LOGGING_NO_STACKTRACE, LOGGING_SINGLE_LINE_STACKTRACE, withStacktraceOffset } from './logging';

// This makes it report a single line of the stacktrace of where the e.g. logger.info() call happened
// while also making it that if we're logging an error, only the first 4 lines of the stack (including the error message) are shown
// (usually the errors we report on happen deep inside ssh2 or ssh2-streams, we don't really care that much about it)
const LOGGING_HANDLE_ERROR = withStacktraceOffset(1, { ...LOGGING_SINGLE_LINE_STACKTRACE, maxErrorStack: 4 });

// All absolute paths (relative to the FS root)
// If it ends with /, .startsWith is used, otherwise a raw equal
const IGNORE_NOT_FOUND: string[] = [
  '/.vscode',
  '/.vscode/',
  '/.git/',
  '/node_modules',
  '/pom.xml',
];
function shouldIgnoreNotFound(path: string) {
  return IGNORE_NOT_FOUND.some(entry => entry === path || entry.endsWith('/') && path.startsWith(entry));
}

export class SSHFileSystem implements vscode.FileSystemProvider {
  protected onCloseEmitter = new vscode.EventEmitter<void>();
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public waitForContinue = false;
  public closed = false;
  public closing = false;
  public copy = undefined;
  public onClose = this.onCloseEmitter.event;
  public onDidChangeFile = this.onDidChangeFileEmitter.event;
  protected logging: Logger;
  constructor(public readonly authority: string, protected sftp: ssh2.SFTPWrapper,
    public readonly root: string, public readonly config: FileSystemConfig) {
    this.logging = Logging.scope(`SSHFileSystem(${root})`, false);
    this.sftp.on('end', () => (this.closed = true, this.onCloseEmitter.fire()));
    this.logging.info('SSHFileSystem created');
  }
  public disconnect() {
    this.closing = true;
    this.sftp.end();
  }
  public relative(relPath: string) {
    if (relPath.startsWith('/')) relPath = relPath.substr(1);
    return path.posix.resolve(this.root, relPath);
  }
  public continuePromise<T>(func: (cb: (err: Error | null | undefined, res?: T) => void) => boolean): Promise<T> {
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
  /* FileSystemProvider */
  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // throw new Error('Method not implemented.');
    return new vscode.Disposable(() => { });
  }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await this.continuePromise<ssh2s.Stats>(cb => this.sftp.stat(this.relative(uri.path), cb))
      .catch(e => this.handleError(uri, e, true) as never);
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
    const entries = await this.continuePromise<ssh2s.FileEntry[]>(cb => this.sftp.readdir(this.relative(uri.path), cb))
      .catch((e) => this.handleError(uri, e, true) as never);
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
        this.logging.warning(`Error in readDirectory for ${furi}`, LOGGING_NO_STACKTRACE);
        this.logging.warning(e, LOGGING_SINGLE_LINE_STACKTRACE);
        // tslint:disable-next-line:no-bitwise
        return [file.filename, vscode.FileType.Unknown | link] as [string, vscode.FileType];
      }
    }));
  }
  public createDirectory(uri: vscode.Uri): void | Promise<void> {
    return this.continuePromise<void>(cb => this.sftp.mkdir(this.relative(uri.path), cb)).catch(e => this.handleError(uri, e, true));
  }
  public readFile(uri: vscode.Uri): Uint8Array | Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const stream = this.sftp.createReadStream(this.relative(uri.path), { autoClose: true });
      const bufs = [];
      stream.on('data', bufs.push.bind(bufs));
      stream.on('error', e => this.handleError(uri, e, reject));
      stream.on('close', () => {
        resolve(new Uint8Array(Buffer.concat(bufs)));
      });
    });
  }
  public writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Promise<void> {
    return new Promise(async (resolve, reject) => {
      let mode: number | string | undefined;
      let fileExists = false;
      try {
        const stat = await this.continuePromise<ssh2s.Stats>(cb => this.sftp.stat(this.relative(uri.path), cb));
        mode = stat.mode;
        fileExists = true;
      } catch (e) {
        if (e.message === 'No such file') {
          mode = this.config.newFileMode;
        } else {
          this.handleError(uri, e);
          vscode.window.showWarningMessage(`Couldn't read the permissions for '${this.relative(uri.path)}', permissions might be overwritten`);
        }
      }
      mode = mode as number | undefined; // ssh2-streams supports an octal number as string, but ssh2's typings don't reflect this
      const stream = this.sftp.createWriteStream(this.relative(uri.path), { mode, flags: 'w' });
      stream.on('error', e => this.handleError(uri, e, reject));
      stream.end(content, () => {
        this.onDidChangeFileEmitter.fire([{ uri, type: fileExists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created }]);
        resolve();
      });
    });
  }
  public async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<any> {
    const stats = await this.stat(uri);
    const fireEvent = () => this.onDidChangeFileEmitter.fire([{ uri, type: vscode.FileChangeType.Deleted }]);
    // tslint:disable no-bitwise */
    if (stats.type & (vscode.FileType.SymbolicLink | vscode.FileType.File)) {
      return this.continuePromise(cb => this.sftp.unlink(this.relative(uri.path), cb))
        .then(fireEvent).catch(e => this.handleError(uri, e, true));
    } else if ((stats.type & vscode.FileType.Directory) && options.recursive) {
      return this.continuePromise(cb => this.sftp.rmdir(this.relative(uri.path), cb))
        .then(fireEvent).catch(e => this.handleError(uri, e, true));
    }
    return this.continuePromise(cb => this.sftp.unlink(this.relative(uri.path), cb))
      .then(fireEvent).catch(e => this.handleError(uri, e, true));
    // tslint:enable no-bitwise */
  }
  public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): void | Promise<void> {
    return this.continuePromise<void>(cb => this.sftp.rename(this.relative(oldUri.path), this.relative(newUri.path), cb))
      .then(() => this.onDidChangeFileEmitter.fire([
        { uri: oldUri, type: vscode.FileChangeType.Deleted },
        { uri: newUri, type: vscode.FileChangeType.Created }
      ]))
      .catch(e => this.handleError(newUri, e, true));
  }
  // Helper function to handle/report errors with proper (and minimal) stacktraces and such
  protected handleError(uri: vscode.Uri, e: Error & { code?: any }, doThrow: (boolean | ((error: any) => void)) = false): any {
    if (e.code === 2 && shouldIgnoreNotFound(uri.path)) {
      // Whenever a workspace opens, VSCode (and extensions) (indirectly) stat a bunch of files
      // (.vscode/tasks.json etc, .git/, node_modules for NodeJS, pom.xml for Maven, ...)
      this.logging.debug(`Ignored FileNotFound error for: ${uri}`, LOGGING_NO_STACKTRACE);
      if (doThrow === true) throw e; else if (doThrow) return doThrow(e); else return;
    }
    Logging.error(`Error handling uri: ${uri}`, LOGGING_NO_STACKTRACE);
    Logging.error(e, LOGGING_HANDLE_ERROR);
    // Convert SSH2Stream error codes into VS Code errors
    if (doThrow && typeof e.code === 'number') {
      const oldE = e;
      if (e.code === 2) { // No such file or directory
        e = vscode.FileSystemError.FileNotFound(uri);
      } else if (e.code === 3) { // Permission denied
        e = vscode.FileSystemError.NoPermissions(uri);
      } else if (e.code === 6) { // No connection
        e = vscode.FileSystemError.Unavailable(uri);
      } else if (e.code === 7) { // Connection lost
        e = vscode.FileSystemError.Unavailable(uri);
      }
      if (e !== oldE) Logging.debug(`Error converted to: ${e}`);
    }
    if (doThrow === true) throw e;
    if (doThrow) return doThrow(e);
  }
}

export const EMPTY_FILE_SYSTEM = {
  onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
  watch: (uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }) => new vscode.Disposable(() => { }),
  stat: (uri: vscode.Uri) => {
    console.warn('Checking', uri.toString());
    if (uri.path === '/' || uri.path === '\\') return ({ type: vscode.FileType.Directory }) as vscode.FileStat;
    throw vscode.FileSystemError.FileNotFound(uri);
  },
  readDirectory: (uri: vscode.Uri) => [],
  createDirectory: (uri: vscode.Uri) => { },
  readFile: (uri: vscode.Uri) => new Uint8Array(0),
  writeFile: (uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }) => { },
  delete: (uri: vscode.Uri, options: { recursive: boolean; }) => { },
  rename: (oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) => { },
} as vscode.FileSystemProvider;
