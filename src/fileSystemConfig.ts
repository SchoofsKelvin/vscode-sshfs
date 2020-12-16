import type { ConnectConfig } from 'ssh2';

export interface ProxyConfig {
  type: 'socks4' | 'socks5' | 'http';
  host: string;
  port: number;
}

export type ConfigLocation = number | string;

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
  /** Path on the remote server where the root path in vscode should point to. Defaults to / */
  root?: string;
  /** A name of a PuTTY session, or `true` to find the PuTTY session from the host address  */
  putty?: string | boolean;
  /** Optional object defining a proxy to use */
  proxy?: ProxyConfig;
  /** Optional path to a private keyfile to authenticate with */
  privateKeyPath?: string;
  /** A name of another config to use as a hop */
  hop?: string;
  /** A command to run on the remote SSH session to start a SFTP session (defaults to sftp subsystem) */
  sftpCommand?: string;
  /** Whether to use a sudo shell (and for which user) to run the sftpCommand in (sftpCommand defaults to /usr/lib/openssh/sftp-server if missing) */
  sftpSudo?: string | boolean;
  /** The filemode to assign to created files */
  newFileMode?: number | string;
  /** Internal property saying where this config comes from. Undefined if this config is merged or something */
  _location?: ConfigLocation;
  /** Internal property keeping track of where this config comes from (including merges) */
  _locations: ConfigLocation[];
  /** Internal property keeping track of whether this config is an actually calculated one, and if so, which config it originates from (normally itself) */
  _calculated?: FileSystemConfig;
}

export function invalidConfigName(name: string) {
  if (!name) return 'Missing a name for this SSH FS';
  if (name.match(/^[\w_\\\/\.@\-+]+$/)) return null;
  return `A SSH FS name can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@`;
}
