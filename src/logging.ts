import * as vscode from 'vscode';
import { FileSystemConfig } from './fileSystemConfig';

// Since the Extension Development Host runs with debugger, we can use this to detect if we're debugging
export const DEBUG: number | undefined = process.execArgv.find(a => a.includes('--inspect')) ? 3000 : undefined;

if (DEBUG) {
  console.warn('[vscode-sshfs] Detected we are running in debug mode');
  import('source-map-support/register').catch(e => console.warn('Could not register source-map-support:', e));
}

const outputChannel = vscode.window.createOutputChannel('ssh-fs');

interface LoggingOptions {
  /** The level of outputting the logger's name/stacktrace:
   * 0: Don't report anything
   * 1: Only report the name (or first line of stacktrace if missing)
   * 2: Report name and stacktrace (if available)
   */
  reportedFromLevel: number;
  /** Whether to output a stacktrace of the .info() call etc
   * 0: Don't output a stacktrace
   * -1: Output the whole stacktrace
   * N: Only output the first N frames
  */
  callStacktrace: number;
}

class Logger {
  protected parent?: Logger;
  protected stack?: string;
  protected defaultLoggingOptions: LoggingOptions = {
    reportedFromLevel: 0,
    callStacktrace: 0,
  };
  protected constructor(protected name?: string, generateStack: number | boolean = false) {
    if (generateStack) {
      const len = typeof generateStack === 'number' ? generateStack : 5;
      let stack = new Error().stack;
      stack = stack && stack.split('\n').slice(3, 3 + len).join('\n');
      this.stack = stack || '<stack unavailable>';
    }
  }
  protected do_print(type: string, message: string, options: LoggingOptions) {
    options = { ...this.defaultLoggingOptions, ...options };
    const { reportedFromLevel } = options;
    // Calculate prefix
    const prefix = this.name ? `[${this.name}] ` : '';
    // Calculate suffix
    let suffix = '';
    if (this.name && this.stack && reportedFromLevel >= 2) {
      suffix = `\nReported from ${this.name}:\n${this.stack}`;
    } else if (this.name && reportedFromLevel >= 1) {
      suffix = `\nReported from ${this.name}`;
    } else if (this.stack && reportedFromLevel >= 2) {
      suffix = `\nReported from:\n${this.stack}`;
    }
    // If there is a parent logger, pass the message with prefix/suffix on
    if (this.parent) return this.parent.do_print(type, `${prefix}${message}${suffix}`, options);
    // There is no parent, we're responsible for actually logging the message
    const space = ' '.repeat(Math.max(0, 8 - type.length));
    const msg = `[${type}]${space}${prefix}${message}${suffix}`
    outputChannel.appendLine(msg);
    if (DEBUG) (console[type.toLowerCase()] || console.log).call(console, msg);
  }
  protected print(type: string, message: string | Error, options: Partial<LoggingOptions>) {
    options = { ...this.defaultLoggingOptions, ...options };
    // Format errors with stacktraces to display the stacktrace
    if (message instanceof Error && message.stack) {
      message = `${message.message}\n${message.stack}`;
    }
    // Do we need to also output a stacktrace?
    const { reportedFromLevel = 0 } = options;
    if (reportedFromLevel) {
      let stack = new Error().stack;
      let split = stack && stack.split('\n');
      split = split && split.slice(3, reportedFromLevel > 0 ? 3 + reportedFromLevel : undefined);
      stack = split ? split.join('\n') : '<stack unavailable>';
      message += `\nLogged at:\n${stack}`;
    }
    // Start the (recursive parent-related) printing
    this.do_print(type, `${message}`, options as LoggingOptions)
  }
  public here(name?: string) {
    const logger = new Logger(name, true);
    logger.parent = this;
    return logger;
  }
  public debug(message: string, options: Partial<LoggingOptions> = {}) {
    this.print('DEBUG', message, options);
  }
  public info(message: string, options: Partial<LoggingOptions> = {}) {
    this.print('INFO', message, options);
  }
  public warning(message: string, options: Partial<LoggingOptions> = {}) {
    this.print('WARNING', message, { callStacktrace: 3, reportedFromLevel: 2, ...options });
  }
  public error(message: string | Error, options: Partial<LoggingOptions> = {}) {
    this.print('ERROR', message, { callStacktrace: 5, reportedFromLevel: 2, ...options });
  }
}

export interface CensoredFileSystemConfig extends Omit<FileSystemConfig, 'sock' | '_calculated'> {
  sock?: string;
  _calculated?: CensoredFileSystemConfig;
}

export function censorConfig(config: FileSystemConfig): CensoredFileSystemConfig {
  return {
    ...config,
    password: typeof config.password === 'string' ? '<censored>' : config.password,
    passphrase: typeof config.passphrase === 'string' ? '<censored>' : config.passphrase,
    privateKey: config.privateKey instanceof Buffer ? `Buffer(${config.privateKey.length})` : config.privateKey,
    sock: config.sock ? '<socket>' : config.sock,
    _calculated: config._calculated ? censorConfig(config._calculated) : config._calculated,
  };
}

export const Logging = new (Logger as any) as Logger;

Logging.info('Created output channel for vscode-sshfs');
