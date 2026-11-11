
/**
 * OpenSSH client configuration (`~/.ssh/config`) support.
 *
 * This module is intentionally free of any `vscode` import: it only parses the
 * configuration files and resolves them the way `ssh` would for a given host.
 * Nothing in here is ever written to disk or to the VS Code settings.
 *
 * Supported (see `ssh_config(5)`):
 * - `Host` blocks, including wildcards (`*`, `?`) and negation (`!pattern`)
 * - `Match` blocks with `all`, `host`, `originalhost`, `user`, `localuser` and `final`
 *   (`exec`, `canonical`, `tagged`, ... are never executed/matched)
 * - `Include` (with globs, `~` and relative paths), also inside `Host`/`Match` blocks
 * - "first obtained value wins" semantics, quoting, `key=value` and trailing comments
 * - `%` tokens, `~` and `${ENV}` expansion
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshConfigSource {
  /** Absolute path of the file this entry was read from */
  file: string;
  /** 1-based line number */
  line: number;
}

interface OptionNode { type: 'option'; keyword: string; args: string[]; raw: string; source: SshConfigSource; }
interface HostNode { type: 'host'; patterns: string[]; source: SshConfigSource; }
interface MatchCriterion { keyword: string; negated: boolean; arg?: string; }
interface MatchNode { type: 'match'; criteria: MatchCriterion[]; source: SshConfigSource; }
interface IncludeNode { type: 'include'; files: ParsedSshConfigFile[]; source: SshConfigSource; }
type SshConfigNode = OptionNode | HostNode | MatchNode | IncludeNode;

export interface ParsedSshConfigFile {
  path: string;
  exists: boolean;
  nodes: SshConfigNode[];
}

/** Everything about the local machine that influences how a config gets resolved */
export interface SshConfigEnvironment {
  home: string;
  username: string;
  hostname: string;
  uid: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export function getDefaultEnvironment(): SshConfigEnvironment {
  let username = '';
  try { username = os.userInfo().username; } catch { username = process.env.USER || process.env.USERNAME || ''; }
  return {
    username,
    home: os.homedir(),
    hostname: os.hostname(),
    uid: typeof process.getuid === 'function' ? `${process.getuid()}` : '',
    platform: process.platform,
    env: process.env,
  };
}

export function getUserConfigPath(env: SshConfigEnvironment): string {
  return path.join(env.home, '.ssh', 'config');
}

export function getSystemConfigPath(env: SshConfigEnvironment): string {
  if (env.platform === 'win32') return path.join(env.env.PROGRAMDATA || env.env.ProgramData || 'C:\\ProgramData', 'ssh', 'ssh_config');
  return '/etc/ssh/ssh_config';
}

/* ---------------------------------- Parsing ---------------------------------- */

/** Keywords whose argument is the raw remainder of the line (a command), exactly like OpenSSH handles them */
const RAW_KEYWORDS = new Set(['proxycommand', 'remotecommand', 'localcommand', 'knownhostscommand']);
/** Match criteria that take an argument */
const MATCH_WITH_ARG = new Set(['host', 'originalhost', 'user', 'localuser', 'exec', 'tagged', 'localnetwork', 'command', 'sessiontype', 'version']);
const MAX_INCLUDE_DEPTH = 16;

/**
 * Splits a config line into arguments the way OpenSSH's `argv_split` does:
 * whitespace separated, single/double quotes group, `\` only escapes quotes/backslashes
 * (and spaces outside of quotes), and an unquoted `#` starts a comment.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n || input[i] === '#') break;
    let token = '';
    let quote: string | null = null;
    for (; i < n; i++) {
      const c = input[i];
      const next = input[i + 1];
      if (quote) {
        if (c === quote) { quote = null; continue; }
        if (c === '\\' && (next === quote || next === '\\')) { token += next; i++; continue; }
        token += c;
      } else {
        if (/\s/.test(c)) break;
        if (c === '"' || c === '\'') { quote = c; continue; }
        if (c === '\\' && (next === '"' || next === '\'' || next === '\\' || next === ' ')) { token += next; i++; continue; }
        token += c;
      }
    }
    out.push(token);
  }
  return out;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts an OpenSSH pattern (`*` and `?` wildcards) to a RegExp */
function patternToRegex(pattern: string): RegExp {
  let source = '';
  for (const c of pattern) source += c === '*' ? '.*' : (c === '?' ? '.' : escapeRegex(c));
  return new RegExp(`^${source}$`);
}

export function matchPattern(value: string, pattern: string): boolean {
  return patternToRegex(pattern).test(value);
}

/** OpenSSH's `match_pattern_list`: comma separated, a matching negated pattern always wins */
export function matchPatternList(value: string, list: string): boolean {
  let matched = false;
  for (let pattern of list.split(',')) {
    pattern = pattern.trim();
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.substring(1);
    if (!matchPattern(value, pattern)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/** A `Host` line matches if any positive pattern matches and no negated pattern does */
function matchHostPatterns(host: string, patterns: string[]): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (!matchPattern(host, negated ? pattern.substring(1) : pattern)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function expandEnvironment(value: string, env: SshConfigEnvironment): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
    const found = env.env[name];
    return found === undefined ? full : found;
  });
}

function expandTilde(value: string, env: SshConfigEnvironment): string {
  if (value === '~') return env.home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(env.home, value.substring(2));
  const own = `~${env.username}`;
  if (env.username && (value === own || value.startsWith(`${own}/`))) return path.join(env.home, value.substring(own.length + 1));
  return value;
}

function globSegmentToRegex(segment: string): RegExp {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') source += '[^/\\\\]*';
    else if (c === '?') source += '[^/\\\\]';
    else if (c === '[') {
      const end = segment.indexOf(']', i + 2);
      if (end === -1) { source += '\\['; continue; }
      let body = segment.substring(i + 1, end);
      const negated = body[0] === '!' || body[0] === '^';
      if (negated) body = body.substring(1);
      source += `[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      i = end;
    } else source += escapeRegex(c);
  }
  return new RegExp(`^${source}$`);
}

/** Minimal `glob(7)` implementation, enough for `Include` (wildcards may appear in any path segment) */
export async function expandGlob(pattern: string): Promise<string[]> {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const { root } = path.parse(pattern);
  const segments = pattern.substring(root.length).split(path.sep === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean);
  let current: string[] = [root || '.'];
  for (const segment of segments) {
    const next: string[] = [];
    if (!/[*?[]/.test(segment)) {
      for (const dir of current) next.push(path.join(dir, segment));
    } else {
      const regex = globSegmentToRegex(segment);
      for (const dir of current) {
        let names: string[];
        try { names = await fs.promises.readdir(dir); } catch { continue; }
        for (const name of names.sort()) {
          // Just like glob(7), wildcards do not match hidden files unless the pattern explicitly starts with a dot
          if (name.startsWith('.') && !segment.startsWith('.')) continue;
          if (regex.test(name)) next.push(path.join(dir, name));
        }
      }
    }
    current = next;
    if (!current.length) break;
  }
  return current;
}

export interface ParseContext {
  env: SshConfigEnvironment;
  /** Directory that relative `Include` paths are resolved against (`~/.ssh` for user configs) */
  baseDir: string;
  /** Gets filled with every file that we (tried to) read, useful for watching for changes */
  files: Set<string>;
  warn?(message: string): void;
}

export async function parseSshConfigFile(file: string, ctx: ParseContext, depth = 0): Promise<ParsedSshConfigFile> {
  const result: ParsedSshConfigFile = { path: file, exists: false, nodes: [] };
  ctx.files.add(file);
  let content: string;
  try {
    content = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.warn?.(`Could not read SSH config file '${file}': ${(e as Error).message}`);
    return result;
  }
  result.exists = true;
  if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1); // Windows editors like adding a BOM
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const source: SshConfigSource = { file, line: index + 1 };
    const match = /^([^\s="]+)\s*(?:=\s*)?(.*)$/.exec(line);
    if (!match) {
      ctx.warn?.(`${file}:${index + 1}: could not parse line, ignoring it`);
      continue;
    }
    const keyword = match[1].toLowerCase();
    const raw = match[2].trim();
    if (RAW_KEYWORDS.has(keyword)) {
      if (!raw) continue;
      result.nodes.push({ type: 'option', keyword, raw, args: [raw], source });
      continue;
    }
    const args = tokenize(raw);
    if (!args.length) {
      ctx.warn?.(`${file}:${index + 1}: missing argument for '${match[1]}', ignoring it`);
      continue;
    }
    switch (keyword) {
      case 'host':
        result.nodes.push({ type: 'host', patterns: args, source });
        break;
      case 'match': {
        const criteria: MatchCriterion[] = [];
        for (let i = 0; i < args.length; i++) {
          let name = args[i].toLowerCase();
          // `Match host=foo` is also valid syntax
          let arg: string | undefined;
          const eq = name.indexOf('=');
          if (eq !== -1) { arg = args[i].substring(eq + 1); name = name.substring(0, eq); }
          const negated = name.startsWith('!');
          if (negated) name = name.substring(1);
          if (MATCH_WITH_ARG.has(name) && arg === undefined) arg = args[++i];
          criteria.push({ keyword: name, negated, arg });
        }
        result.nodes.push({ type: 'match', criteria, source });
        break;
      }
      case 'include': {
        const node: IncludeNode = { type: 'include', files: [], source };
        result.nodes.push(node);
        if (depth >= MAX_INCLUDE_DEPTH) {
          ctx.warn?.(`${file}:${index + 1}: too many nested Include directives, ignoring it`);
          break;
        }
        for (const arg of args) {
          let target = expandTilde(expandEnvironment(arg, ctx.env), ctx.env);
          if (!path.isAbsolute(target)) target = path.join(ctx.baseDir, target);
          for (const found of await expandGlob(target)) {
            node.files.push(await parseSshConfigFile(found, ctx, depth + 1));
          }
        }
        break;
      }
      default:
        result.nodes.push({ type: 'option', keyword, args, raw, source });
    }
  }
  return result;
}

/* --------------------------------- Resolving --------------------------------- */

export interface ListedSshHost {
  /** The alias exactly as written on the `Host` line */
  alias: string;
  source: SshConfigSource;
}

/** Lists every concrete (non-wildcard, non-negated) `Host` alias, in order of appearance */
export function listSshHosts(files: ParsedSshConfigFile[]): ListedSshHost[] {
  const result: ListedSshHost[] = [];
  const seen = new Set<string>();
  const walk = (nodes: SshConfigNode[]) => {
    for (const node of nodes) {
      if (node.type === 'include') {
        node.files.forEach(file => walk(file.nodes));
      } else if (node.type === 'host') {
        for (const alias of node.patterns) {
          if (/[*?!,]/.test(alias) || seen.has(alias)) continue;
          seen.add(alias);
          result.push({ alias, source: node.source });
        }
      }
    }
  };
  files.forEach(file => walk(file.nodes));
  return result;
}

interface ResolvedOption { args: string[]; raw: string; source: SshConfigSource; }

export interface ResolvedSshHost {
  alias: string;
  /** First obtained value for every (lowercased) keyword */
  options: Map<string, ResolvedOption>;
  /** Accumulated values for the keywords that can be specified multiple times */
  identityFiles: string[];
  setEnv: string[];
  /** Whether at least one `Host`/`Match` block other than a pure catch-all (`Host *`) applied */
  explicit: boolean;
}

/** Whichever of ProxyJump/ProxyCommand comes first wins, and disables the other one (even if it's `none`) */
const PROXY_KEYWORDS = ['proxyjump', 'proxycommand'];

function evaluateMatch(node: MatchNode, resolved: ResolvedSshHost, env: SshConfigEnvironment, warn?: (message: string) => void): boolean {
  for (const { keyword, negated, arg } of node.criteria) {
    let result: boolean;
    switch (keyword) {
      case 'all':
      // We only do a single pass, in which `final` is approximated as "always", using the HostName obtained so far
      case 'final':
        result = true;
        break;
      case 'host': {
        const hostname = resolved.options.get('hostname')?.args[0];
        result = matchPatternList(hostname ? hostname.replace(/%h/g, resolved.alias).replace(/%%/g, '%') : resolved.alias, arg || '');
        break;
      }
      case 'originalhost':
        result = matchPatternList(resolved.alias, arg || '');
        break;
      case 'user':
        result = matchPatternList(resolved.options.get('user')?.args[0] || env.username, arg || '');
        break;
      case 'localuser':
        result = matchPatternList(env.username, arg || '');
        break;
      default:
        // `exec` would run arbitrary local commands just to list hosts, the others need
        // information we do not have (canonicalisation, tags, ...). The block never applies.
        warn?.(`${node.source.file}:${node.source.line}: 'Match ${keyword}' is not supported, this block is skipped`);
        return false;
    }
    if (result === negated) return false;
  }
  return true;
}

/** Resolves the effective options for the given host (alias), like `ssh -G <host>` would */
export function resolveSshHost(files: ParsedSshConfigFile[], alias: string, env: SshConfigEnvironment, warn?: (message: string) => void): ResolvedSshHost {
  const resolved: ResolvedSshHost = { alias, options: new Map(), identityFiles: [], setEnv: [], explicit: false };
  const walk = (nodes: SshConfigNode[], parentActive: boolean) => {
    let active = parentActive;
    for (const node of nodes) {
      switch (node.type) {
        case 'host':
          active = parentActive && matchHostPatterns(alias, node.patterns);
          if (active && node.patterns.some(p => p !== '*' && !p.startsWith('!'))) resolved.explicit = true;
          break;
        case 'match':
          active = parentActive && evaluateMatch(node, resolved, env, warn);
          if (active && node.criteria.some(c => c.keyword !== 'all' && c.keyword !== 'final')) resolved.explicit = true;
          break;
        case 'include':
          // Host/Match blocks inside of the included file never leak into the including file
          node.files.forEach(file => walk(file.nodes, active));
          break;
        case 'option': {
          if (!active) break;
          const { keyword, args, raw, source } = node;
          if (keyword === 'identityfile') {
            resolved.identityFiles.push(args[0]);
          } else if (keyword === 'setenv') {
            resolved.setEnv.push(...args);
          } else if (PROXY_KEYWORDS.includes(keyword)) {
            if (!PROXY_KEYWORDS.some(k => resolved.options.has(k))) resolved.options.set(keyword, { args, raw, source });
          } else if (!resolved.options.has(keyword)) {
            resolved.options.set(keyword, { args, raw, source });
          }
        }
      }
    }
  };
  files.forEach(file => walk(file.nodes, true));
  return resolved;
}

/* -------------------------------- Converting -------------------------------- */

/** Plain data describing how to connect to a host. Structurally a subset of `FileSystemConfig` */
export interface SshHostConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  agent?: string;
  agentForward?: boolean;
  identityFiles: string[];
  identitiesOnly?: boolean;
  proxyJump?: string;
  proxyCommand?: string;
  remoteCommand?: string;
  readyTimeout?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  environment?: Record<string, string>;
  _sshConfigHost: string;
  _sshAuth: { publickey: boolean; password: boolean; keyboard: boolean };
  _sshAgentDisabled?: boolean;
}

/** The identity files `ssh` tries when no `IdentityFile` is configured (those ssh2 can actually use) */
const DEFAULT_IDENTITY_FILES = ['id_rsa', 'id_ecdsa', 'id_ed25519', 'id_dsa'];

const isNone = (value?: string) => !!value && value.toLowerCase() === 'none';
const isYes = (value?: string) => !!value && ['yes', 'true', 'on'].includes(value.toLowerCase());
const isNo = (value?: string) => !!value && ['no', 'false', 'off'].includes(value.toLowerCase());

function parsePositiveInt(value?: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 && parsed <= max ? parsed : undefined;
}

/** Parses time formats like `30`, `30s`, `5m` or `1h30m` into seconds */
function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  let rest = value.toLowerCase();
  while (rest) {
    const match = /^(\d+)([smhdw])/.exec(rest);
    if (!match) return undefined;
    total += Number(match[1]) * units[match[2]];
    rest = rest.substring(match[0].length);
  }
  return total;
}

function expandTokens(value: string, tokens: Record<string, string>): string {
  return value.replace(/%(.)/g, (full, token: string) => token === '%' ? '%' : (token in tokens ? tokens[token] : full));
}

/**
 * Tokens in commands (ProxyCommand/RemoteCommand) that are left alone here, to be expanded right before connecting.
 * By then the final host/port/user are known, which might differ (e.g. `otheruser@alias` or a jump host with a custom port).
 */
const CONNECT_TIME_TOKENS = ['h', 'p', 'r', 'n', '%'];

function expandCommandTokens(value: string, tokens: Record<string, string>): string {
  return value.replace(/%(.)/g, (full, token: string) => !CONNECT_TIME_TOKENS.includes(token) && token in tokens ? tokens[token] : full);
}

export function sshHostToConfig(resolved: ResolvedSshHost, env: SshConfigEnvironment): SshHostConfig {
  const get = (keyword: string) => resolved.options.get(keyword)?.args[0];
  const getRaw = (keyword: string) => resolved.options.get(keyword)?.raw;
  const alias = resolved.alias;
  const host = expandTokens(get('hostname') || alias, { h: alias });
  const port = parsePositiveInt(get('port'), 65535);
  const username = get('user') || env.username;
  const proxyJump = get('proxyjump');
  const tokens: Record<string, string> = {
    h: host, n: alias, p: `${port || 22}`, r: username,
    u: env.username, d: env.home, i: env.uid,
    l: env.hostname, L: env.hostname.split('.')[0],
    j: proxyJump && !isNone(proxyJump) ? proxyJump : '',
    k: get('hostkeyalias') || host,
  };
  tokens.C = createHash('sha1').update(tokens.l + tokens.h + tokens.p + tokens.r + tokens.j).digest('hex');
  const expandPath = (value: string) => expandTilde(expandTokens(expandEnvironment(value, env), tokens), env);
  const config: SshHostConfig = {
    host, username,
    name: alias,
    identityFiles: [],
    _sshConfigHost: alias,
    _sshAuth: { publickey: true, password: true, keyboard: true },
  };
  if (port) config.port = port;
  // Identity files: explicit ones, otherwise the same default ones `ssh` would try (if they exist)
  if (resolved.identityFiles.length) {
    for (const file of resolved.identityFiles) {
      if (isNone(file)) continue;
      const expanded = expandPath(file);
      if (!config.identityFiles.includes(expanded)) config.identityFiles.push(expanded);
    }
  } else {
    for (const file of DEFAULT_IDENTITY_FILES) {
      const full = path.join(env.home, '.ssh', file);
      if (fs.existsSync(full)) config.identityFiles.push(full);
    }
  }
  if (isYes(get('identitiesonly'))) config.identitiesOnly = true;
  // Agent: IdentityAgent, falling back to $SSH_AUTH_SOCK (or the OpenSSH agent service on Windows)
  // If there is no (working) agent there, other well-known locations are tried when connecting, see sshAuth.ts
  const identityAgent = get('identityagent');
  if (identityAgent && isNone(identityAgent)) {
    // No agent at all, not even one we could find ourselves
    config._sshAgentDisabled = true;
  } else if (identityAgent && identityAgent !== 'SSH_AUTH_SOCK') {
    config.agent = identityAgent.startsWith('$') && !identityAgent.startsWith('${')
      ? env.env[identityAgent.substring(1)] : expandPath(identityAgent);
  } else {
    config.agent = env.env.SSH_AUTH_SOCK || (env.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
  }
  if (!config.agent) delete config.agent;
  const forwardAgent = get('forwardagent');
  if (forwardAgent && !isNo(forwardAgent) && config.agent) config.agentForward = true;
  // Proxying (only one of both can be present, see resolveSshHost)
  if (proxyJump && !isNone(proxyJump)) config.proxyJump = proxyJump;
  const proxyCommand = getRaw('proxycommand');
  if (proxyCommand && !isNone(proxyCommand)) config.proxyCommand = expandCommandTokens(expandEnvironment(proxyCommand, env), tokens);
  const remoteCommand = getRaw('remotecommand');
  if (remoteCommand && !isNone(remoteCommand)) config.remoteCommand = expandCommandTokens(remoteCommand, tokens);
  // Timeouts and keepalives
  const connectTimeout = parseTime(get('connecttimeout'));
  if (connectTimeout) config.readyTimeout = connectTimeout * 1000;
  const aliveInterval = parseTime(get('serveraliveinterval'));
  if (aliveInterval) config.keepaliveInterval = aliveInterval * 1000;
  const aliveCountMax = parsePositiveInt(get('serveralivecountmax'));
  if (aliveCountMax) config.keepaliveCountMax = aliveCountMax;
  // Environment variables (the first definition of a variable wins)
  for (const entry of resolved.setEnv) {
    const index = entry.indexOf('=');
    if (index < 1) continue;
    config.environment ||= {};
    const key = entry.substring(0, index);
    if (!(key in config.environment)) config.environment[key] = entry.substring(index + 1);
  }
  // Authentication methods
  const preferred = get('preferredauthentications')?.toLowerCase().split(',').map(s => s.trim());
  const allowed = (method: string, ...keywords: string[]) =>
    !keywords.some(k => isNo(get(k))) && (!preferred || preferred.includes(method));
  config._sshAuth = {
    publickey: allowed('publickey', 'pubkeyauthentication'),
    password: allowed('password', 'passwordauthentication'),
    keyboard: allowed('keyboard-interactive', 'kbdinteractiveauthentication', 'challengeresponseauthentication'),
  };
  return config;
}

/* ------------------------------- Jump hosts ------------------------------- */

export interface JumpSpec { host: string; username?: string; port?: number; }

/** Parses a single ProxyJump entry: `[user@]host[:port]`, `[user@][ipv6]:port` or `ssh://[user@]host[:port]` */
export function parseJumpSpec(spec: string): JumpSpec | undefined {
  spec = spec.trim().replace(/^ssh:\/\//i, '').replace(/\/+$/, '');
  if (!spec) return undefined;
  const result: JumpSpec = { host: spec };
  const at = spec.lastIndexOf('@');
  if (at > 0) {
    result.username = spec.substring(0, at);
    spec = spec.substring(at + 1);
  } else if (at === 0) {
    spec = spec.substring(1);
  }
  let match = /^\[([^\]]+)\](?::(\d+))?$/.exec(spec);
  if (!match && (spec.match(/:/g) || []).length === 1) match = /^([^:]+):(\d+)$/.exec(spec);
  if (match) {
    result.host = match[1];
    if (match[2]) result.port = parsePositiveInt(match[2], 65535);
  } else {
    result.host = spec;
  }
  return result.host ? result : undefined;
}

/** Splits a ProxyJump value (`a,b,c`) into its hops, in connection order */
export function splitProxyJump(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/* ------------------------------ High-level API ------------------------------ */

export interface LoadedSshConfig {
  env: SshConfigEnvironment;
  files: ParsedSshConfigFile[];
  /** Every file we (tried to) read, including included files and missing top-level files */
  watch: string[];
}

/**
 * Loads the given config files (in order of precedence). When no paths are given, the
 * user's `~/.ssh/config` and the system-wide `ssh_config` are used, just like `ssh` does.
 */
export async function loadSshConfig(paths?: string[], warn?: (message: string) => void, env = getDefaultEnvironment()): Promise<LoadedSshConfig> {
  const watch = new Set<string>();
  const files: ParsedSshConfigFile[] = [];
  const userDir = path.join(env.home, '.ssh');
  const systemPath = getSystemConfigPath(env);
  const targets = paths?.length
    ? paths.map(p => path.resolve(expandTilde(expandEnvironment(p, env), env)))
    : [getUserConfigPath(env), systemPath];
  for (const target of targets) {
    const baseDir = target === systemPath ? path.dirname(systemPath) : userDir;
    files.push(await parseSshConfigFile(target, { env, baseDir, warn, files: watch }));
  }
  return { env, files, watch: [...watch] };
}

export function getSshHostConfig(loaded: LoadedSshConfig, alias: string, warn?: (message: string) => void): SshHostConfig & { _explicit: boolean } {
  const resolved = resolveSshHost(loaded.files, alias, loaded.env, warn);
  return { ...sshHostToConfig(resolved, loaded.env), _explicit: resolved.explicit };
}
