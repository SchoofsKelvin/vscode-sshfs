
import type { FileSystemConfig } from 'common/fileSystemConfig';
import * as path from 'path';
import type * as ssh2 from 'ssh2';
import * as vscode from 'vscode';
import { FlagValue, getFlag, subscribeToGlobalFlags } from './flags';
import { Logger, Logging, LOGGING_NO_STACKTRACE, LOGGING_SINGLE_LINE_STACKTRACE, withStacktraceOffset } from './logging';
import { toPromise } from './utils';

// This makes it report a single line of the stacktrace of where the e.g. logger.info() call happened
// while also making it that if we're logging an error, only the first 4 lines of the stack (including the error message) are shown
// (usually the errors we report on happen deep inside ssh2 or ssh2-streams, we don't really care that much about it)
const LOGGING_HANDLE_ERROR = withStacktraceOffset(1, { ...LOGGING_SINGLE_LINE_STACKTRACE, maxErrorStack: 4 });

// All absolute paths (relative to the FS root or a workspace root)
// If it ends with /, .startsWith is used, otherwise a raw equal
const IGNORE_NOT_FOUND: string[] = [
  '/.vscode',
  '/.vscode/',
  '/.git/',
  '/node_modules',
  '/pom.xml',
  '/app/src/main/AndroidManifest.xml',
  '/build.gradle',
  '/.devcontainer/devcontainer.json',
  '/pyproject.toml',
];
function shouldIgnoreNotFound(target: string) {
  if (IGNORE_NOT_FOUND.some(entry => entry === target || entry.endsWith('/') && target.startsWith(entry))) return true;
  for (const { uri: { path: wsPath } } of vscode.workspace.workspaceFolders || []) {
    if (!target.startsWith(wsPath)) continue;
    let local = path.posix.relative(wsPath, target);
    if (!local.startsWith('/')) local = `/${local}`;
    if (IGNORE_NOT_FOUND.some(entry => entry === local || entry.endsWith('/') && local.startsWith(entry))) return true;
  }
  return false;
}

const DEBUG_NOTIFY_FLAGS: Record<string, string[] | undefined> = {};
DEBUG_NOTIFY_FLAGS.write = ['createdirectory', 'writefile', 'delete', 'rename'];
DEBUG_NOTIFY_FLAGS.all = [...DEBUG_NOTIFY_FLAGS.write, 'readdirectory', 'readfile', 'stat'];

export class SSHFileSystem implements vscode.FileSystemProvider {
  protected onCloseEmitter = new vscode.EventEmitter<void>();
  protected onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  protected debugFlags: string[];
  protected notifyErrorFlags: string[];
  public closed = false;
  public closing = false;
  public copy = undefined;
  public onClose = this.onCloseEmitter.event;
  public onDidChangeFile = this.onDidChangeFileEmitter.event;
  protected logging: Logger;
  constructor(public readonly authority: string, protected sftp: ssh2.SFTP, public readonly config: FileSystemConfig) {
    this.logging = Logging.scope(`SSHFileSystem(${authority})`, false);
    this.sftp.on('end', () => (this.closed = true, this.onCloseEmitter.fire()));
    this.logging.info('SSHFileSystem created');
    const subscription = subscribeToGlobalFlags(() => {
      // DEBUG_FS flag, with support for an 'all' alias
      this.debugFlags = `${getFlag('DEBUG_FS', this.config.flags)?.[0] || ''}`.toLowerCase().split(/,\s*|\s+/g);
      if (this.debugFlags.includes('all')) this.debugFlags.push('showignored', 'full', 'converted');
      // FS_NOTIFY_ERRORS flag, with support for a 'write' and 'all' alias, defined in DEBUG_NOTIFY_FLAGS 
      let notifyErrorFlag: FlagValue = (getFlag('FS_NOTIFY_ERRORS', this.config.flags) || ['write'])[0];
      if (notifyErrorFlag === true) notifyErrorFlag = 'all'; // Flag used to be a boolean flag in v1.25.0 and earlier
      this.notifyErrorFlags = (typeof notifyErrorFlag === 'string' ? notifyErrorFlag.toLowerCase().split(/,\s*|\s+/g) : []);
      for (const flag of this.notifyErrorFlags) {
        const alias = DEBUG_NOTIFY_FLAGS[flag];
        if (alias) this.notifyErrorFlags.push(...alias);
      }
    });
    this.onClose(() => subscription.dispose());
  }
  public disconnect() {
    this.closing = true;
    this.sftp.end();
  }
  /* FileSystemProvider */
  public watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
    // throw new Error('Method not implemented.');
    return new vscode.Disposable(() => { });
  }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const stat = await toPromise<ssh2.sftp.Stats>(cb => this.sftp.stat(uri.path, cb))
      .catch(e => this.handleError('stat', uri, e, true) as never);
    const { mtime = 0, size = 0 } = stat;
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
    const entries = await toPromise<ssh2.sftp.DirectoryEntry[]>(cb => this.sftp.readdir(uri.path, cb))
      .catch((e) => this.handleError('readDirectory', uri, e, true) as never);
    return Promise.all(entries.map(async (file) => {
      const furi = uri.with({ path: `${uri.path}${uri.path.endsWith('/') ? '' : '/'}${file.filename}` });
      // Mode in octal representation is 120XXX for links, e.g. 120777
      // Any link's mode & 170000 should equal 120000 (using the octal system, at least)
      // tslint:disable-next-line:no-bitwise
      const link = (file.attrs.mode! & 61440) === 40960 ? vscode.FileType.SymbolicLink : 0;
      try {
        const type = (await this.stat(furi)).type;
        // tslint:disable-next-line:no-bitwise
        return [file.filename, type | link] as [string, vscode.FileType];
      } catch (e) {
        this.logging.warning.withOptions(LOGGING_SINGLE_LINE_STACKTRACE)`Error in readDirectory for ${furi}: ${e}`;
        // tslint:disable-next-line:no-bitwise
        return [file.filename, vscode.FileType.Unknown | link] as [string, vscode.FileType];
      }
    }));
  }
  public createDirectory(uri: vscode.Uri): void | Promise<void> {
    return toPromise<void>(cb => this.sftp.mkdir(uri.path, cb)).catch(e => this.handleError('createDirectory', uri, e, true));
  }
  public readFile(uri: vscode.Uri): Uint8Array | Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const stream = this.sftp.createReadStream(uri.path, { autoClose: true });
      const bufs = [];
      stream.on('data', bufs.push.bind(bufs));
      stream.on('error', e => this.handleError('readFile', uri, e, reject));
      stream.on('close', () => {
        resolve(new Uint8Array(Buffer.concat(bufs)));
      });
    });
  }
  public writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Promise<void> {
    return new Promise(async (resolve, reject) => {
      let mode: number | undefined;
      let fileExists = false;
      try {
        const stat = await toPromise<ssh2.sftp.Stats>(cb => this.sftp.stat(uri.path, cb));
        mode = stat.mode;
        fileExists = true;
      } catch (e) {
        if (e.message === 'No such file') {
          mode = this.config.newFileMode as number;
          if (typeof mode === 'string') mode = Number(mode);
          if (typeof mode !== 'number') mode = 0o664;
          if (Number.isNaN(mode)) throw new Error(`Invalid umask '${this.config.newFileMode}'`);
        } else {
          this.handleError('writeFile', uri, e);
          vscode.window.showWarningMessage(`Couldn't read the permissions for '${uri.path}', permissions might be overwritten`);
        }
      }
      const stream = this.sftp.createWriteStream(uri.path, { mode, flags: 'w' });
      stream.on('error', e => this.handleError('writeFile', uri, e, reject));
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
      return toPromise(cb => this.sftp.unlink(uri.path, cb))
        .then(fireEvent).catch(e => this.handleError('delete', uri, e, true));
    } else if ((stats.type & vscode.FileType.Directory) && options.recursive) {
      return toPromise(cb => this.sftp.rmdir(uri.path, cb))
        .then(fireEvent).catch(e => this.handleError('delete', uri, e, true));
    }
    return toPromise(cb => this.sftp.unlink(uri.path, cb))
      .then(fireEvent).catch(e => this.handleError('delete', uri, e, true));
    // tslint:enable no-bitwise */
  }
  public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): void | Promise<void> {
    return toPromise<void>(cb => this.sftp.rename(oldUri.path, newUri.path, cb))
      .then(() => this.onDidChangeFileEmitter.fire([
        { uri: oldUri, type: vscode.FileChangeType.Deleted },
        { uri: newUri, type: vscode.FileChangeType.Created }
      ]))
      .catch(e => this.handleError('rename', newUri, e, true));
  }
  // Helper function to handle/report errors with proper (and minimal) stacktraces and such
  protected handleError(method: string, uri: vscode.Uri, e: Error & { code?: any }, doThrow: (boolean | ((error: any) => void)) = false): any {
    const ignore = e.code === 2 && [method === 'stat', shouldIgnoreNotFound(uri.path)];
    if (ignore && ignore.includes(true) && !this.debugFlags.includes('disableignored')) {
      e = vscode.FileSystemError.FileNotFound(uri);
      // Whenever a workspace opens, VSCode (and extensions) (indirectly) stat a bunch of files
      // (.vscode/tasks.json etc, .git/, node_modules for NodeJS, pom.xml for Maven, ...)
      if (this.debugFlags.includes('showignored')) {
        const flags = `${ignore[0] ? 'F' : ''}${ignore[1] ? 'A' : ''}`;
        this.logging.debug(`Ignored (${flags}) FileNotFound error for ${method}: ${uri}`, LOGGING_NO_STACKTRACE);
      }
      if (doThrow === true) throw e; else if (doThrow) return doThrow(e); else return;
    }
    else if (this.debugFlags.includes('full')) {
      this.logging.debug.withOptions(LOGGING_HANDLE_ERROR)`Error during ${method} ${uri}: ${e}`;
    } else if (this.debugFlags.includes('minimal')) {
      this.logging.debug.withOptions({ ...LOGGING_NO_STACKTRACE, maxErrorStack: 0 })`Error during ${method} ${uri}: ${e.name}: ${e.message}`;
    }
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
      if (e !== oldE && this.debugFlags.includes('converted'))
        Logging.debug(`Error converted to: ${e}`);
    }
    // Display an error notification if the FS_ERROR_NOTIFICATION flag is enabled
    if (this.notifyErrorFlags.includes(method.toLowerCase())) {
      vscode.window.showErrorMessage(`Error handling ${method} for: ${uri}\n${e.message || e}`);
    }
    if (doThrow === true) throw e;
    if (doThrow) return doThrow(e);
  }
}
