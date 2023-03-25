import { FileSystemConfig, isFileSystemConfig } from 'common/fileSystemConfig';
import * as vscode from 'vscode';

// Since the Extension Development Host runs with debugger, we can use this to detect if we're debugging.
// The only things it currently does is copying Logging messages to the console, while also enabling
// the webview (Settings UI) from trying a local dev server first instead of the pre-built version.
export let DEBUG: boolean = false;
export function setDebug(debug: boolean) {
  console.warn(`[vscode-sshfs] Debug mode set to ${debug}`);
  DEBUG = debug;
  if (!debug) return;
  try { require('.pnp.cjs').setup(); } catch (e) {
    console.warn('Could not set up .pnp.cjs:', e);
  }
  try { require('source-map-support').install(); } catch (e) {
    console.warn('Could not install source-map-support:', e);
  }
}

export const OUTPUT_CHANNEL = vscode.window.createOutputChannel('SSH FS');

export interface LoggingOptions {
  /**
   * The level of outputting the logger's name/stacktrace:
   * - `0`: Don't report anything (default for `WARNING`/`ERROR`)
   * - `1`: Only report the name (or first line of stacktrace if missing)
   * - `2`: Report name and stacktrace (if available) (default for `WARNING`/`ERROR`)
   */
  reportedFromLevel: number;
  /**
   * Whether to output a stacktrace of the .info() call etc
   * - `0`: Don't output a stacktrace
   * - `-1`: Output the whole stacktrace
   * - `N`: Only output the first N frames
   * 
   * Defaults to `3` for `WARNING`, `5` for `ERROR` and `0` for everything else.
  */
  callStacktrace: number;
  /**
   * Used with `.callStacktrace` to skip the given amount of stacktraces in the beginning.
   * Useful when `.info()` etc is called from a helper function which itself isn't worth logging the stacktrace of.
   * Defaults to `0` meaning no offset.
   */
  callStacktraceOffset: number;
  /**
   * Used when the "message" to be logged is an Error object with a stack:
   * - `0`: Don't output the stack (which is the default for `DEBUG` and `INFO`)
   * - `-1`: Output the whole stack
   * - `N`: Only output the first N lines
   */
  maxErrorStack: number;
}

export const LOGGING_NO_STACKTRACE: Partial<LoggingOptions> = { callStacktrace: 0 };
export const LOGGING_SINGLE_LINE_STACKTRACE: Partial<LoggingOptions> = { callStacktrace: 1 };

function hasPromiseCause(error: Error): error is Error & { promiseCause: Error; promiseCauseName: string } {
  return 'promiseCause' in error && (error as any).promiseCause instanceof Error;
}

export type LoggerDefaultLevels = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface LoggerForType {
  logger: Logger;
  type: LoggerDefaultLevels;
  options: Partial<LoggingOptions>;
  (error: Error, options?: Partial<LoggingOptions>): void;
  (message: string, options?: Partial<LoggingOptions>): void;
  (template: TemplateStringsArray, ...args: any[]): void;
  withOptions(options: Partial<LoggingOptions>): LoggerForType;
}

class Logger {
  protected parent?: Logger;
  protected stack?: string;
  protected defaultLoggingOptions: LoggingOptions = {
    reportedFromLevel: 0,
    callStacktrace: 0,
    callStacktraceOffset: 0,
    maxErrorStack: 0,
  };
  protected constructor(protected name?: string, generateStack: number | boolean = false) {
    if (generateStack) {
      const len = typeof generateStack === 'number' ? generateStack : 1;
      const stack = new Error().stack?.split('\n').slice(3, 3 + len).join('\n');
      this.stack = stack || '<stack unavailable>';
    }
  }
  protected doPrint(type: string, message: string, options: LoggingOptions) {
    const { reportedFromLevel } = options;
    // Calculate prefix
    const prefix = this.name ? `[${this.name}] ` : '';
    // Calculate suffix
    let suffix = '';
    if (this.name && this.stack && reportedFromLevel >= 2) {
      suffix = `\nReported by logger ${this.name}:\n${this.stack}`;
    } else if (this.name && reportedFromLevel >= 1) {
      suffix = `\nReported by logger ${this.name}`;
    } else if (this.stack && reportedFromLevel >= 2) {
      suffix = `\nReported by logger:\n${this.stack}`;
    } else if (this.stack && reportedFromLevel === 1) {
      suffix = `\nReported by logger:\n${this.stack.split('\n', 2)[0]}`;
    }
    // If there is a parent logger, pass the message with prefix/suffix on
    if (this.parent) return this.parent.doPrint(type, `${prefix}${message}${suffix}`, options);
    // There is no parent, we're responsible for actually logging the message
    const space = ' '.repeat(Math.max(0, 8 - type.length));
    const msg = `[${type}]${space}${prefix}${message}${suffix}`
    OUTPUT_CHANNEL.appendLine(msg);
    // VS Code issue where console.debug logs twice in the Debug Console
    if (type.toLowerCase() === 'debug') type = 'log';
    if (DEBUG) (console[type.toLowerCase()] || console.log).call(console, msg);
  }
  protected formatValue(value: any, options: LoggingOptions): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error && value.stack) {
      // Format errors with stacktraces to display the JSON and the stacktrace if needed
      let result = `${value.name}: ${value.message}`;
      try {
        const json = JSON.stringify(value);
        if (json !== '{}') result += `\nJSON: ${json}`;
      } finally { }
      const { maxErrorStack } = options;
      if (value.stack && maxErrorStack) {
        let { stack } = value;
        if (maxErrorStack > 0) {
          stack = stack.split(/\n/g).slice(0, maxErrorStack + 1).join('\n');
        }
        result += '\n' + stack;
      }
      if (maxErrorStack !== 0) for (let cause = value; hasPromiseCause(cause); cause = cause.promiseCause) {
        let promiseStack = cause.promiseCause.stack?.split(/\n/g);
        if (!promiseStack) continue;
        if (maxErrorStack > 0) promiseStack = promiseStack.slice(1, maxErrorStack + 1);
        result += `\nCaused by ${cause.promiseCauseName || 'promise'}:\n${promiseStack.join('\n')}`;
      }
      return result;
    } else if (value instanceof vscode.Uri) {
      return value.toString();
    } else if (isFileSystemConfig(value)) {
      return JSON.stringify(censorConfig(value), null, 4);
    }
    try {
      const short = JSON.stringify(value);
      if (short.length < 100) return short;
      return JSON.stringify(value, null, 4);
    } catch (e) {
      try { return `${value}`; } catch (e) {
        return `[Error formatting value: ${e.message || e}]`;
      }
    }
  }
  protected print(type: string, message: string | Error, partialOptions?: Partial<LoggingOptions>) {
    const options: LoggingOptions = { ...this.defaultLoggingOptions, ...partialOptions };
    message = this.formatValue(message, options);
    // Do we need to also output a stacktrace?
    const { callStacktrace, callStacktraceOffset = 0 } = options;
    if (callStacktrace) {
      let stack = new Error().stack;
      let split = stack && stack.split('\n');
      split = split && split.slice(callStacktraceOffset + 3, callStacktrace > 0 ? callStacktraceOffset + 3 + callStacktrace : undefined);
      stack = split ? split.join('\n') : '<stack unavailable>';
      message += `\nLogged at:\n${stack}`;
    }
    // Start the (recursive parent-related) printing
    this.doPrint(type.toUpperCase(), message, options as LoggingOptions)
  }
  protected printTemplate(type: string, template: TemplateStringsArray, args: any[], partialOptions?: Partial<LoggingOptions>) {
    const options: LoggingOptions = { ...this.defaultLoggingOptions, ...partialOptions };
    options.callStacktraceOffset = (options.callStacktraceOffset || 0) + 1;
    this.print(type, template.reduce((acc, part, i) => acc + part + (i < args.length ? this.formatValue(args[i], options) : ''), ''), partialOptions);
  }
  public scope(name?: string, generateStack: number | boolean = false) {
    const logger = new Logger(name, generateStack);
    logger.parent = this;
    return logger;
  }
  public wrapType(type: LoggerDefaultLevels, options: Partial<LoggingOptions> = {}): LoggerForType {
    const result: LoggerForType = (message: string | Error | TemplateStringsArray, ...args: any[]) => {
      const options = { ...result.options };
      options.callStacktraceOffset = (options.callStacktraceOffset || 0) + 1;
      if (typeof message === 'string' || message instanceof Error) {
        return result.logger.print(result.type, message, options)
      } else if (Array.isArray(message)) {
        return result.logger.printTemplate(result.type, message, args, options)
      }
      result.logger.error`Trying to log type ${type} with message=${message} and args=${args}`;
    };
    result.logger = this;
    result.type = type;
    result.options = options;
    result.withOptions = newOptions => this.wrapType(result.type, { ...result.options, ...newOptions });
    return result;
  }
  public debug = this.wrapType('DEBUG');
  public info = this.wrapType('INFO');
  public warning = this.wrapType('WARNING', { callStacktrace: 3, reportedFromLevel: 2 });
  public error = this.wrapType('ERROR', { callStacktrace: 5, reportedFromLevel: 2, maxErrorStack: 10 });
}

export type { Logger };

export function withStacktraceOffset(amount: number = 1, options: Partial<LoggingOptions> = {}): Partial<LoggingOptions> {
  return { ...options, callStacktraceOffset: (options.callStacktraceOffset || 0) + amount };
}

export interface CensoredFileSystemConfig extends Omit<FileSystemConfig, 'sock' | '_calculated'> {
  sock?: string;
  _calculated?: CensoredFileSystemConfig;
}

function censorConfig(config: FileSystemConfig): CensoredFileSystemConfig {
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

Logging.info`
Created output channel for vscode-sshfs
When posting your logs somewhere, keep the following in mind:
  - While the logging tries to censor your passwords/passphrases/..., double check!
    Maybe you also want to censor out e.g. the hostname/IP you're connecting to.
  - If you want to report an issue regarding authentication or something else that
    seems to be more of an issue with the actual SSH2 connection, it might be handy
    to reconnect with this added to your User Settings (settings.json) first:
      "sshfs.flags": [ "DEBUG_SSH2" ],
    This will (for new connections) also enable internal SSH2 logging.
`;
