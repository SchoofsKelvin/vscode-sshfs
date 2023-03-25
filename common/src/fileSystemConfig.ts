import type { ConnectConfig } from 'ssh2';
import './ssh2';

export interface ProxyConfig {
  type: 'socks4' | 'socks5' | 'http';
  host: string;
  port: number;
}

export type ConfigLocation = number | string;

/** Might support conditional stuff later, although ssh2/OpenSSH might not support that natively */
export interface EnvironmentVariable {
  key: string;
  value: string;
}

export function formatConfigLocation(location?: ConfigLocation): string {
  if (!location) return 'Unknown location';
  if (typeof location === 'number') {
    return `${[, 'Global', 'Workspace', 'WorkspaceFolder'][location] || 'Unknown'} settings.json`;
  }
  return location;
}

export function getLocations(configs: FileSystemConfig[]): ConfigLocation[] {
  const res: ConfigLocation[] = [1, 2 /*, 3*/]; // No WorkspaceFolder support (for now)
  // TODO: Suggest creating sshfs.jsonc etc in current workspace folder(s) (UI feature?)
  for (const { _location } of configs) {
    if (!_location) continue;
    if (!res.find(l => l === _location)) {
      res.push(_location);
    }
  }
  return res;
}

export function getGroups(configs: FileSystemConfig[], expanded = false): string[] {
  const res: string[] = [];
  function addGroup(group: string) {
    if (!res.find(l => l === group)) {
      res.push(group);
    }
  }
  for (const { group } of configs) {
    if (!group) continue;
    const groups = expanded ? group.split('.') : [group];
    groups.forEach((g, i) => addGroup([...groups.slice(0, i), g].join('.')));
  }
  return res;
}

export function groupByLocation(configs: FileSystemConfig[]): [ConfigLocation, FileSystemConfig[]][] {
  const res: [ConfigLocation, FileSystemConfig[]][] = [];
  function getForLoc(loc: ConfigLocation = 'Unknown') {
    let found = res.find(([l]) => l === loc);
    if (found) return found;
    found = [loc, []];
    res.push(found);
    return found;
  }
  for (const config of configs) {
    getForLoc(config._location!)[1].push(config);
  }
  return res;
}

export function groupByGroup(configs: FileSystemConfig[]): [string, FileSystemConfig[]][] {
  const res: [string, FileSystemConfig[]][] = [];
  function getForGroup(group: string = '') {
    let found = res.find(([l]) => l === group);
    if (found) return found;
    found = [group, []];
    res.push(found);
    return found;
  }
  for (const config of configs) {
    getForGroup(config.group)[1].push(config);
  }
  return res;
}

export interface FileSystemConfig extends ConnectConfig {
  /** Name of the config. Can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@ */
  name: string;
  /** Optional label to display in some UI places (e.g. popups) */
  label?: string;
  /** Optional group for this config, to group configs together in some UI places. Allows subgroups, in the format "Group1.SubGroup1.Subgroup2" */
  group?: string;
  /** Whether to merge this "lower" config (e.g. from workspace settings) into higher configs (e.g. from global settings) */
  merge?: boolean;
  /** Names of other existing configs to merge into this config. Earlier entries overridden by later entries overridden by this config itself */
  extend?: string | string[];
  /** Path on the remote server that should be opened by default when creating a terminal or using the `Add as Workspace folder` command/button. Defaults to `/` */
  root?: string;
  /** A name of a PuTTY session, or `true` to find the PuTTY session from the host address  */
  putty?: string | boolean;
  /** Optional object defining a proxy to use */
  proxy?: ProxyConfig;
  /** Optional path to a private keyfile to authenticate with */
  privateKeyPath?: string;
  /** A name of another config to use as a hop */
  hop?: string;
  /** The command to run on the remote SSH session to start a SFTP session (defaults to sftp subsystem) */
  sftpCommand?: string;
  /** Whether to use a sudo shell (and for which user) to run the sftpCommand in (sftpCommand defaults to /usr/lib/openssh/sftp-server if missing) */
  sftpSudo?: string | boolean;
  /** The command(s) to run when a new SSH terminal gets created. Defaults to `$SHELL`. Internally the command `cd ...` is run first */
  terminalCommand?: string | string[];
  /** The command(s) to run when a `ssh-shell` task gets run. Defaults to the placeholder `$COMMAND`. Internally the command `cd ...` is run first */
  taskCommand?: string | string[];
  /** An object with environment variables to add to the SSH connection. Affects the whole connection thus all terminals */
  environment?: EnvironmentVariable[] | Record<string, string>;
  /** The filemode to assign to new files created using VS Code, not the terminal. Similar to umask. Defaults to `rw-rw-r--` (regardless of server config, whether you are root, ...) */
  newFileMode?: number | string;
  /** Whether this config was created from an instant connection string. Enables fuzzy matching for e.g. PuTTY, config-by-host, ... */
  instantConnection?: boolean;
  /** List of special flags to enable/disable certain fixes/features. Flags are usually used for issues or beta testing. Flags can disappear/change anytime! */
  flags?: string[];
  /** Internal property saying where this config comes from. Undefined if this config is merged or something */
  _location?: ConfigLocation;
  /** Internal property keeping track of where this config comes from (including merges) */
  _locations: ConfigLocation[];
  /** Internal property keeping track of whether this config is an actually calculated one, and if so, which config it originates from (normally itself) */
  _calculated?: FileSystemConfig;
}

export function isFileSystemConfig(config: any): config is FileSystemConfig {
  return typeof config === 'object' && typeof config.name === 'string' && Array.isArray(config._locations);
}

export function invalidConfigName(name: string) {
  if (!name) return 'Missing a name for this SSH FS';
  if (name.match(/^[\w_\\/.@\-+]+$/)) return null;
  return `A SSH FS name can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@`;
}

/**
 * https://regexr.com/5m3gl (mostly based on https://tools.ietf.org/html/draft-ietf-secsh-scp-sftp-ssh-uri-04)
 * Supports several formats, the first one being the "full" format, with others being partial:
 * - `user;abc=def,a-b=1-5@server.example.com:22/some/file.ext`
 * - `user@server.example.com/directory`
 * - `server:22/directory`
 * - `test-user@server`
 * - `server`
 * - `@server/path` - Unlike OpenSSH, we allow a @ (and connection parameters) without a username
 * 
 * The resulting FileSystemConfig will have as name basically the input, but without the path. If there is no
 * username given, the name will start with `@`, as to differentiate between connection strings and config names.
 */
const CONNECTION_REGEX = /^((?<user>[\w\-._]+)?(;[\w-]+=[\w\d-]+(,[\w\d-]+=[\w\d-]+)*)?@)?(?<host>[^\s@\\/:,=]+)(:(?<port>\d+))?(?<path>\/\S*)?$/;

export function parseConnectionString(input: string): [config: FileSystemConfig, path?: string] | string {
  input = input.trim();
  const match = input.match(CONNECTION_REGEX);
  if (!match) return 'Invalid format, expected something like "user@example.com:22/some/path"';
  const { user, host, path } = match.groups!;
  const portStr = match.groups!.port;
  const port = portStr ? Number.parseInt(portStr) : undefined;
  if (portStr && (!port || port < 1 || port > 65535)) return `The string '${port}' is not a valid port number`;
  const name = `${user || ''}@${host}${port ? `:${port}` : ''}${path || ''}`;
  return [{
    name, host, port,
    instantConnection: true,
    username: user || '$USERNAME',
    _locations: [],
  }, path];
}
