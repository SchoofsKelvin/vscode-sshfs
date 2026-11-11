
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Duplex } from 'stream';

export interface ProxyCommandOptions {
  /** Called for every (non-empty) line the command writes to stderr */
  onStderr?(line: string): void;
  /** Environment for the command. Defaults to our own environment */
  env?: NodeJS.ProcessEnv;
}

/**
 * Wraps a locally running command (OpenSSH's `ProxyCommand`) as a duplex stream: everything
 * written to the stream goes to the command's stdin, everything it outputs on stdout can be read.
 * The command gets killed when the stream is destroyed (e.g. when the SSH connection closes).
 */
export class ProxyCommandStream extends Duplex {
  /** The last few lines the command wrote to stderr, handy for error messages */
  public readonly stderrLines: string[] = [];
  protected exited = false;
  /** Whether we are the ones closing the connection, in which case the exit code of the command doesn't matter anymore */
  protected ending = false;
  constructor(public readonly command: string, protected readonly child: ChildProcessWithoutNullStreams, options: ProxyCommandOptions = {}) {
    super();
    // Whoever uses this stream (ssh2) adds its own listener, this just prevents a failing
    // command from throwing an unhandled 'error' event before that listener got added
    this.on('error', () => { });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.on('error', error => this.destroy(error));
    // Writing to a command that already exited results in EPIPE, which gets handled through the close event
    child.stdin.on('error', error => this.exited || this.destroy(error));
    let pending = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) this.addStderrLine(line, options);
    });
    child.stderr.on('end', () => this.addStderrLine(pending, options));
    child.on('error', error => {
      this.exited = true;
      this.destroy(new Error(`Could not run ProxyCommand '${command}': ${error.message}`));
    });
    child.on('exit', () => this.exited = true);
    // Only signal the end of the stream once the command is completely done (which also means that we got all
    // of its output), so that a failing command results in a proper error instead of just a "connection lost"
    child.on('close', (code, signal) => {
      this.exited = true;
      if (this.destroyed) return;
      if (!this.ending && code) return this.destroy(new Error(this.describeFailure(`exited with code ${code}`)));
      if (!this.ending && signal) return this.destroy(new Error(this.describeFailure(`got killed by ${signal}`)));
      this.push(null);
    });
  }
  protected addStderrLine(line: string, options: ProxyCommandOptions) {
    line = line.trimEnd();
    if (!line) return;
    this.stderrLines.push(line);
    if (this.stderrLines.length > 10) this.stderrLines.shift();
    options.onStderr?.(line);
  }
  protected describeFailure(reason: string): string {
    const output = this.stderrLines.length ? `:\n${this.stderrLines.join('\n')}` : '';
    return `ProxyCommand '${this.command}' ${reason}${output}`;
  }
  public _read() {
    this.child.stdout.resume();
  }
  public _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.exited || !this.child.stdin.writable) return callback(new Error(this.describeFailure('is not running anymore')));
    this.child.stdin.write(chunk, encoding, callback);
  }
  public _final(callback: (error?: Error | null) => void) {
    this.ending = true;
    if (this.exited || !this.child.stdin.writable) return callback();
    this.child.stdin.end(() => callback());
  }
  public _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.ending = true;
    this.kill();
    callback(error);
  }
  protected kill() {
    const { child } = this;
    if (this.exited || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      if (process.platform === 'win32') {
        // On Windows the command runs inside of cmd.exe, killing just that would leave the actual command running
        spawn('taskkill', ['/pid', `${child.pid}`, '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      } else {
        child.kill();
      }
    } catch {
      // Already gone
    }
  }
}

/**
 * Starts the given command using the user's shell, just like OpenSSH does for `ProxyCommand`.
 * Resolves once the command got spawned, with a stream connected to its stdin/stdout.
 */
export function spawnProxyCommand(command: string, options: ProxyCommandOptions = {}): Promise<ProxyCommandStream> {
  return new Promise<ProxyCommandStream>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      if (process.platform === 'win32') {
        child = spawn(command, { shell: true, windowsHide: true, env: options.env, stdio: 'pipe' });
      } else {
        // `exec` avoids a lingering shell process, which also makes sure that we kill the right process later on
        child = spawn(process.env.SHELL || '/bin/sh', ['-c', `exec ${command}`], { env: options.env, stdio: 'pipe' });
      }
    } catch (e) {
      return reject(new Error(`Could not run ProxyCommand '${command}': ${(e as Error).message}`));
    }
    const stream = new ProxyCommandStream(command, child, options);
    child.once('spawn', () => resolve(stream));
    child.once('error', error => reject(new Error(`Could not run ProxyCommand '${command}': ${error.message}`)));
  });
}
