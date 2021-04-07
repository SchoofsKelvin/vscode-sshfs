
import * as fs from 'fs';
import { userInfo } from 'os';
import type { FileSystemConfig } from './fileSystemConfig';
import { censorConfig, Logging, LOGGING_NO_STACKTRACE } from './logging';
import { toPromise } from './toPromise';

export enum SSHConfigType {
    GLOBAL = 'GLOBAL',
    HOST = 'HOST',
    MATCH = 'MATCH',
    COMPUTED = 'COMPUTED',
}

const PAIR_REGEX = /^(\w+)\s*(?:=|\s)\s*(.+)$/;
const QUOTE_REGEX = /^"(.*)"$/;

const unquote = (str: string): string => str.replace(QUOTE_REGEX, (_, v) => v);
const replacePatternChar = (ch: string): string => ch == '?' ? '.' : '.*';

function checkHostname(hostname: string, target: string): boolean | undefined {
    if (target === '*') return true;
    const negate = target.startsWith('!');
    if (negate) target = target.substring(1);
    const regex = new RegExp(`^${target.trim().replace(/[*?]/g, replacePatternChar)}$`);
    return regex.test(hostname) ? !negate : undefined;
}

function checkPatternList(input: string, pattern: string): boolean {
    for (const pat of pattern.split(',')) {
        const result = checkHostname(input, pat);
        if (result !== undefined) return result;
    }
    return false;
}

export interface MatchContext {
    hostname: string;
    originalHostname: string;
    user: string;
    localUser?: string;
    isFinalOrCanonical?: boolean;
}
export type MatchResult = [result: boolean, errors: LineError[]];

export class SSHConfig implements Iterable<[string, string[]]> {
    protected entries = new Map<string, string[]>();
    constructor(
        public readonly type: SSHConfigType,
        public readonly source: string,
        public readonly line: number) { }
    public get(key: string): string {
        return this.entries.get(key.toLowerCase())?.[0] || '';
    }
    public getAll(key: string): string[] {
        return this.entries.get(key.toLowerCase())?.slice() || [];
    }
    public set(key: string, value: string | string[]): void {
        if (!Array.isArray(value)) value = [value];
        this.entries.set(key.toLowerCase(), value);
    }
    public add(key: string, value: string | string[]): void {
        if (!Array.isArray(value)) value = [value];
        this.entries.set(key.toLowerCase(), [...this.getAll(key), ...value]);
    }
    public [Symbol.iterator](): IterableIterator<[string, string[]]> {
        return this.entries[Symbol.iterator]();
    }
    public merge(other: SSHConfig): void {
        for (const [key, values] of other) this.add(key, values);
    }
    protected checkHost(hostname: string): boolean {
        let allowed = false;
        for (const pattern of this.get('host').split(/\s+/)) {
            const result = checkHostname(hostname, pattern);
            if (result === true) allowed = true;
            if (result === false) return false;
        }
        return allowed;
    }
    protected checkMatch(context: MatchContext): MatchResult {
        const wrapResult = (result: boolean): MatchResult => [result, []];
        const wrapResultWithError = (result: boolean, error: string): MatchResult => [result, [[this.source, this.line, error, Severity.ERROR]]];
        const split = this.get('match').split(/\s+/);
        let prev = '';
        for (let i = 0, curr: string; curr = split[i]; prev = curr, i++) {
            const lower = curr.toLowerCase();
            if (lower === 'all') {
                if (split.length === 1) return wrapResult(true);
                if (split.length === 2 && i === 1) {
                    if (prev.toLowerCase() === 'final') return wrapResult(!!context.isFinalOrCanonical);
                    if (prev.toLowerCase() === 'canonical') return wrapResult(!!context.isFinalOrCanonical);
                }
                return wrapResultWithError(false, '\'all\' cannot be combined with other Match attributes');
            } else if (lower === 'final' || lower === 'canonical') {
                if (!context.isFinalOrCanonical) return wrapResult(false);
                continue;
            }
            const next = split[++i];
            if (!next) return wrapResultWithError(false, `Match keyword '${lower}' requires argument`);
            if (lower === 'exec') {
                return wrapResultWithError(false, '\'exec\' is not supported for now');
            } else if (lower === 'host') {
                if (!checkPatternList(context.hostname, next)) return wrapResult(false);
            } else if (lower === 'originalhost') {
                if (!checkPatternList(context.originalHostname, next)) return wrapResult(false);
            } else if (lower === 'user') {
                if (!checkPatternList(context.user, next)) return wrapResult(false);
            } else if (lower === 'localuser' && context.localUser) {
                if (!checkPatternList(context.localUser, next)) return wrapResult(false);
            } else {
                return wrapResultWithError(false, `Unknown argument '${curr}' for Match keyword`);
            }
        }
        return wrapResult(true);
    }
    public matches(context: MatchContext): MatchResult {
        if (this.type === SSHConfigType.GLOBAL) return [true, []];
        if (this.type === SSHConfigType.HOST) return [this.checkHost(context.hostname), []];
        if (this.type === SSHConfigType.MATCH) return this.checkMatch(context);
        if (this.type === SSHConfigType.COMPUTED) return [false, [[this.source, 0, 'Cannot match a computed config', Severity.ERROR]]];
        throw new Error(`Unrecognized config type '${this.type}'`);
    }
    public toString(): string {
        if (this.type === SSHConfigType.GLOBAL) return `SSHConfig(GLOBAL,${this.source}:${this.line})`;
        if (this.type === SSHConfigType.HOST) return `SSHConfig(HOST,${this.source}:${this.line},"${this.get('Host')}")`;
        if (this.type === SSHConfigType.MATCH) return `SSHConfig(MATCH,${this.source}:${this.line},"${this.get('Match')}")`;
        if (this.type === SSHConfigType.COMPUTED) return `SSHConfig(COMPUTED,${this.source}:${this.line})`;
        throw new Error(`Unrecognized config type '${this.type}'`);
    }
}

export enum Severity {
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const SEVERITY_TO_STRING = [, 'info', 'warning', 'error'] as const;

export type LineError = [source: string, line: number, message: string, severity: Severity];

export function formatLineError(error: LineError): string {
    return `[${SEVERITY_TO_STRING[error[3]].toUpperCase()}] (${error[0]}:${error[1]}) ${error[2]}`;
}

function mergeConfigIntoContext(config: SSHConfig, context: MatchContext): void {
    context.hostname = config.get('hostname') || context.hostname;
    context.user = config.get('user') || context.user;
}

export class SSHConfigHolder {
    public readonly errors: readonly LineError[] = [];
    public readonly configs: SSHConfig[] = [];
    constructor(public readonly source: string) { }
    public reportError(line: number, message: string, severity = Severity.ERROR): void {
        (this.errors as LineError[]).push([this.source, line, message, severity]);
    }
    public add(config: SSHConfig): void {
        (this.configs as SSHConfig[]).push(config);
    }
    public getHighestSeverity(): Severity | undefined {
        return this.errors.reduceRight((a, b) => a[3] > b[3] ? a : b)?.[3];
    }
    public buildConfig(context: MatchContext): SSHConfig {
        context = { ...context };
        const result = new SSHConfig(SSHConfigType.COMPUTED, this.source, 0);
        for (const config of this.configs) {
            if (!config.matches(context)) {
                Logging.debug(`Config ${config} does not match context ${JSON.stringify(context)}, ignoring`);
                continue;
            }
            Logging.debug(`Config ${config} matches context ${JSON.stringify(context)}, merging`);
            result.merge(config);
            mergeConfigIntoContext(result, context);
            Logging.debug(`  New context: ${JSON.stringify(context)}`);
        }
        return result;
    }
    public merge(other: SSHConfigHolder): void {
        this.configs.push(...other.configs);
        (this.errors as LineError[]).push(...other.errors);
    }
}

const ERR_NO_MATCH = 'Incorrect comment or key-value pair syntax';
const ERR_UNSUPPORTED_FINAL = 'Unsupported Match keyword \'final\'';
const ERR_UNSUPPORTED_CANONICAL = 'Unsupported Match keyword \'canonical\'';
const ERR_MULTIPLE_IDENTITY_FILE = 'Multiple IdentityFiles given, the extension only tries the first one';

export function parseContents(content: string, source: string): SSHConfigHolder {
    const holder = new SSHConfigHolder(source);
    let current = new SSHConfig(SSHConfigType.GLOBAL, source, 0);
    holder.add(current);
    content.split('\n').forEach((line, lineNumber) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const mat = line.match(PAIR_REGEX);
        if (!mat) return holder.reportError(lineNumber, ERR_NO_MATCH);
        let [, key, value] = mat;
        key = key.toLowerCase();
        value = unquote(value);
        // TODO: "Include ..."
        switch (key) {
            case 'host':
                holder.add(current = new SSHConfig(SSHConfigType.HOST, source, lineNumber));
                break;
            case 'match':
                holder.add(current = new SSHConfig(SSHConfigType.MATCH, source, lineNumber));
                const split = value.split(/\s+/).map(v => unquote(v).toLowerCase());
                if (split.includes('final')) holder.reportError(lineNumber, ERR_UNSUPPORTED_FINAL, Severity.WARN);
                if (split.includes('canonical')) holder.reportError(lineNumber, ERR_UNSUPPORTED_CANONICAL, Severity.WARN);
                break;
            case 'identityfile':
                if (current.get('IdentityFile')) {
                    holder.reportError(lineNumber, ERR_MULTIPLE_IDENTITY_FILE, Severity.WARN);
                }
                break;
        }
        current.add(key, value.trim());
    });
    return holder;
}

export async function buildHolder(paths: string[]): Promise<SSHConfigHolder> {
    Logging.info(`Building ssh_config holder for ${paths.length} paths`);
    const holder = new SSHConfigHolder('<root>');
    for (let i = 0, path: string; path = paths[i]; i++) {
        try {
            const content = await toPromise<Buffer>(cb => fs.readFile(path, cb));
            const subholder = parseContents(content.toString(), path);
            holder.merge(subholder);
        } catch (e) {
            if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                const msg = `No ssh_config file found at '${path}', skipping`;
                Logging.info(msg);
                holder.reportError(i, msg, Severity.INFO);
                continue;
            }
            const msg = `Error during building SSHConfigHolder, current path: '${path}'`;
            Logging.error(msg, LOGGING_NO_STACKTRACE);
            Logging.error(e);
            holder.reportError(i, msg);
        }
    }
    const sev = holder.getHighestSeverity();
    if (!sev) return holder;
    const key = SEVERITY_TO_STRING[sev];
    Logging[key](`Building ssh_config holder produced ${key} messages:`, LOGGING_NO_STACKTRACE);
    for (const error of holder.errors) Logging[key]('- ' + formatLineError(error));
    Logging[key]('End of ssh_config holder messages', LOGGING_NO_STACKTRACE);
    return holder;
}

const toBoolean = (str: string): boolean | undefined => str === 'yes' ? true : str === 'no' ? false : undefined;
const toList = (str: string): string[] | undefined => str ? str.split(',') : undefined;

export async function fillFileSystemConfig(config: FileSystemConfig, holder: SSHConfigHolder): Promise<void> {
    const localUser = userInfo().username;
    const context: MatchContext = {
        hostname: config.host!,
        originalHostname: config.host!,
        user: config.username || localUser,
        localUser,
    };
    const result = holder.buildConfig(context);
    const overrides: Partial<FileSystemConfig> = {
        host: result.get('Hostname') || config.host,
        compress: toBoolean(result.get('Compression')),
        // TODO: port forwarding: DynamicForward, LocalForward, RemoteForward, ExitOnForwardFailure, GatewayPorts
        //          StreamLocalBindMask, StreamLocalBindUnlink
        agentForward: toBoolean(result.get('ForwardAgent')),
        // TODO: ForwardX11, ForwardX11Timeout, ForwardX11Trusted, XAuthLocation (maybe?)
        // TODO: host key checking: CheckHostIP, GlobalKnownHostsFile, HashKnownHosts,
        //          KnownHostsCommand, RevokedHostKeys, StrictHostKeyChecking, UserKnownHostsFile
        agent: result.get('IdentityAgent') || config.agent,
        privateKeyPath: result.get('IdentityFile'),
        tryKeyboard: toBoolean(result.get('KbdInteractiveAuthentication')),
        // TODO: LocalCommand, PermitLocalCommand, RemoteCommand
        password: (toBoolean(result.get('PasswordAuthentication')) != false) as any,
        port: parseInt(result.get('Port')),
        // TODO: PreferredAuthentications (ssh2's non-documented authHandler config property?)
        // TODO: ProxyCommand, ProxyJump, ProxyUseFdpass (can't support the latter I'm afraid)
        hops: toList(result.get('ProxyJump')),
        // TODO: SendEnv, SetEnv (maybe?)
        username: result.get('User'),
    };
    // ConnectTimeout
    const connectTimeout = parseInt(result.get('ConnectTimeout'));
    if (!isNaN(connectTimeout)) overrides.readyTimeout = connectTimeout;
    // LogLevel
    const logLevel = result.get('LogLevel');
    if (logLevel) {
        overrides.debug = logLevel.includes('DEBUG') ? msg => {
            Logging.debug(`[ssh2:debug ${config.name}] ${msg}`);
        } : () => { };
    }
    // ProxyCommand
    const proxyCommand = result.get('ProxyCommand');
    if (proxyCommand) {
        overrides.proxy = {
            type: 'command',
            command: proxyCommand,
        };
    }
    // Cleaning up
    for (const key in overrides) {
        const val = overrides[key];
        if (val === '') delete overrides[key];
        if (val === []) delete overrides[key];
        if (typeof val === 'number' && isNaN(val)) delete overrides[key];
        if (val === undefined) delete overrides[key];
    }
    Logging.debug(`Config overrides for ${config.name} generated from ssh_config files: ${JSON.stringify(censorConfig(overrides as any), null, 4)}`);
    Object.assign(config, overrides);
}
