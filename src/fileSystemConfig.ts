import { ConnectConfig } from 'ssh2';

export interface ProxyConfig {
  type: 'socks4' | 'socks5' | 'http';
  host: string;
  port: number;
}

export interface FileSystemConfig extends ConnectConfig {
  /* Name of the config. Can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@ */
  name: string;
  /* Optional label to display in some UI places (e.g. popups) */
  label?: string;
  /* Whether to merge this "lower" config (e.g. from folders) into higher configs (e.g. from global settings) */
  merge?: boolean;
  /* Path on the remote server where the root path in vscode should point to. Defaults to / */
  root?: string;
  /* A name of a PuTTY session, or `true` to find the PuTTY session from the host address  */
  putty?: string | boolean;
  /* Optional object defining a proxy to use */
  proxy?: ProxyConfig;
  /* Optional path to a private keyfile to authenticate with */
  privateKeyPath?: string;
  /* A name of another config to use as a hop */
  hop?: string;
  /* A command to run on the remote SSH session to start a SFTP session (defaults to sftp subsystem) */
  sftpCommand?: string;
  /* Whether to use a sudo shell (and for which user) to run the sftpCommand in (sftpCommand defaults to /usr/lib/openssh/sftp-server if missing) */
  sftpSudo?: string | boolean;
  /* The filemode to assign to created files */
  newFileMode?: number | string;
  /* Internal property keeping track of where this config comes from (including merges) */
  _locations: string[];
}
