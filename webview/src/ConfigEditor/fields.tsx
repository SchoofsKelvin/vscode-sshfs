import * as React from 'react';
import { FieldDropdown } from '../FieldTypes/dropdown';
import { FieldDropdownWithInput } from '../FieldTypes/dropdownwithinput';
import { FieldNumber } from '../FieldTypes/number';
import { FieldPath } from '../FieldTypes/path';
import { FieldString } from '../FieldTypes/string';
import { FileSystemConfig, invalidConfigName } from '../types/fileSystemConfig';
import FieldConfigGroup from './configGroupField';
import { PROXY_FIELD } from './proxyFields';

export type FieldChanged<K = string, V = any> = (field: K, newValue: V) => void;
export type FSCChanged<K extends keyof FileSystemConfig = keyof FileSystemConfig & string> = FieldChanged<K, FileSystemConfig[K]>;
export type FSCChangedMultiple = (newConfig: Partial<FileSystemConfig>) => void;

function pathValidator(value?: string): string | null {
  if (!value) return null;
  // Following characters aren't allowed: \ / : * ? " < > |
  if (value.match(/[\\/][\\/]/)) return 'Double slashes are not allowed';
  return value.match(/^[~\\/]([^\\/:*?"<>|]+[~\\/])*[^\\/:*?"<>|]*/) ? null : 'Path has to start with / or ~/';
}

export function name(config: FileSystemConfig, onChange: FSCChanged<'name'>): React.ReactElement {
  const callback = (value: string) => onChange('name', value);
  const description = 'Name of the config. Can only exists of lowercase alphanumeric characters, slashes and any of these: _.+-@';
  return <FieldString key="name" label="Name" value={config.name} onChange={callback} validator={invalidConfigName} description={description} />
}

export function merge(config: FileSystemConfig, onChange: FSCChanged<'merge'>): React.ReactElement {
  const callback = (newValue: string) => onChange('merge', newValue === 'Yes' || undefined);
  const description = 'Whether to merge this "lower" config (e.g. from workspace settings) into higher configs (e.g. from global settings)';
  const values = ['Yes', 'No'];
  const value = config.merge ? 'Yes' : 'No';
  return <FieldDropdown key="merge" label="Merge" {...{ value, values, description }} onChange={callback} />
}

export function label(config: FileSystemConfig, onChange: FSCChanged<'label'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('label', newValue);
  const description = 'Label to display in some UI places (e.g. popups)';
  return <FieldString key="label" label="Label" value={config.label} onChange={callback} optional description={description} />
}

export function group(config: FileSystemConfig, onChange: FSCChanged<'group'>): React.ReactElement {
  const callback = (newValue: string) => onChange('group', newValue);
  const description = 'Group for this config, to group configs together in some UI places. Allows subgroups, in the format "Group1.SubGroup1.Subgroup2"';
  return <FieldConfigGroup key="group" label="Group" value={config.group} {...{ description }} onChange={callback} optional />
}

export function putty(config: FileSystemConfig, onChange: FSCChanged<'putty'>): React.ReactElement {
  const callback = (newValue: string) => onChange('putty', newValue === '<Auto-detect>' ? true : newValue);
  const description = 'A name of a PuTTY session, or `true` to find the PuTTY session from the host address';
  const values = ['<Auto-detect>'];
  const value = config.putty === true ? '<Auto-detect>' : config.putty || undefined;
  return <FieldDropdownWithInput key="putty" label="PuTTY" {...{ value, values, description }} onChange={callback} optional />
}

export function host(config: FileSystemConfig, onChange: FSCChanged<'host'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('host', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Hostname or IP address of the server. Supports environment variables, e.g. $HOST';
  const values = ['<Prompt>'];
  const value = (config.host as any) === true ? '<Prompt>' : config.host;
  return <FieldDropdownWithInput key="host" label="Host" {...{ value, values, description }} onChange={callback} optional />
}

export function port(config: FileSystemConfig, onChange: FSCChanged<'port'>): React.ReactElement {
  const callback = (value: number) => onChange('port', value);
  const description = 'Port number of the server. Supports environment variables, e.g. $PORT';
  return <FieldNumber key="port" label="Port" value={config.port} onChange={callback} optional description={description} />
}

export function root(config: FileSystemConfig, onChange: FSCChanged<'root'>): React.ReactElement {
  const callback = (value: string) => onChange('root', value);
  const description = 'Path on the remote server where the root path in vscode should point to. Defaults to /';
  return <FieldString key="root" label="Root" value={config.root} onChange={callback} optional validator={pathValidator} description={description} />
}

export function agent(config: FileSystemConfig, onChange: FSCChanged<'agent'>): React.ReactElement {
  const callback = (newValue: string) => onChange('agent', newValue);
  const description = `Path to ssh-agent's UNIX socket for ssh-agent-based user authentication. Supports 'pageant' for PuTTY's Pagent, and environment variables, e.g. $SSH_AUTH_SOCK`;
  const values = ['pageant', '//./pipe/openssh-ssh-agent', '$SSH_AUTH_SOCK'];
  return <FieldDropdownWithInput key="agent" label="Agent" {...{ value: config.agent, values, description }} onChange={callback} optional />
}

export function username(config: FileSystemConfig, onChange: FSCChanged<'username'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('username', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Username for authentication. Supports environment variables, e.g. $USERNAME';
  const values = ['<Prompt>', '$USERNAME'];
  const value = (config.username as any) === true ? '<Prompt>' : config.username;
  return <FieldDropdownWithInput key="username" label="Username" {...{ value, values, description }} onChange={callback} optional />
}

export function password(config: FileSystemConfig, onChange: FSCChanged<'password'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('password', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Password for password-based user authentication. Supports env variables. This gets saved in plaintext! Using prompts or private keys is recommended!';
  const values = ['<Prompt>'];
  const value = (config.password as any) === true ? '<Prompt>' : config.password;
  return <FieldDropdownWithInput key="password" label="Password" {...{ value, values, description }} onChange={callback} optional />
}

export function privateKeyPath(config: FileSystemConfig, onChange: FSCChanged<'privateKeyPath'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('privateKeyPath', newValue);
  const description = 'A path to a private key. Supports environment variables, e.g. `$USERPROFILE/.ssh/myKey.ppk` or `$HOME/.ssh/myKey`';
  return <FieldPath key="privateKeyPath" label="Private key" value={config.privateKeyPath} onChange={callback} optional description={description} />
}

export function passphrase(config: FileSystemConfig, onChange: FSCChanged<'passphrase'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('passphrase', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Passphrase for unlocking an encrypted private key. Supports env variables. This gets saved in plaintext! Using prompts or private keys is recommended!';
  const values = ['<Prompt>'];
  const value = (config.passphrase as any) === true ? '<Prompt>' : config.passphrase;
  return <FieldDropdownWithInput key="passphrase" label="Passphrase" {...{ value, values, description }} onChange={callback} optional />
}

export function sftpCommand(config: FileSystemConfig, onChange: FSCChanged<'sftpCommand'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('sftpCommand', newValue);
  const description = 'A command to run on the remote SSH session to start a SFTP session (defaults to sftp subsystem)';
  return <FieldString key="sftpCommand" label="SFTP Command" value={config.sftpCommand} onChange={callback} optional validator={pathValidator} description={description} />
}

export function sftpSudo(config: FileSystemConfig, onChange: FSCChanged<'sftpSudo'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('sftpSudo', newValue === '<Default>' ? true : newValue);
  const description = 'Whether to use a sudo shell (and for which user) to run the sftpCommand in (if present, gets passed as -u to sudo)';
  const values = ['<Default>'];
  const value = config.sftpSudo === true ? '<Default>' : (typeof config.sftpSudo === 'string' ? config.sftpSudo : undefined);
  return <FieldDropdownWithInput key="sftpSudo" label="SFTP Sudo" {...{ value, values, description }} onChange={callback} optional />
}

export function terminalCommand(config: FileSystemConfig, onChange: FSCChanged<'terminalCommand'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('terminalCommand', (!newValue || newValue === '$SHELL') ? undefined : newValue);
  const description = 'The command(s) to run when a new SSH terminal gets created. Defaults to `$SHELL`. Internally the command `cd ...` is run first';
  const values = ['$SHELL', '/usr/bin/bash', '/usr/bin/sh'];
  let value = config.terminalCommand === '$SHELL' ? '' : config.terminalCommand || '';
  if (Array.isArray(value)) value = value.join('; ');
  return <FieldDropdownWithInput key="terminalCommand" label="Terminal command" {...{ value, values, description }} onChange={callback} optional />
}

export function taskCommand(config: FileSystemConfig, onChange: FSCChanged<'taskCommand'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('taskCommand', newValue);
  const description = 'The command(s) to run when a `ssh-shell` task gets run. Defaults to the placeholder `$COMMAND`. Internally the command `cd ...` is run first';
  const values = ['$COMMAND'];
  let value = config.taskCommand;
  if (Array.isArray(value)) value = value.join('; ');
  return <FieldDropdownWithInput key="taskCommand" label="Task command" {...{ value, values, description }} onChange={callback} optional />
}

export type FieldFactory = (config: FileSystemConfig, onChange: FSCChanged, onChangeMultiple: FSCChangedMultiple) => React.ReactElement | null;
export const FIELDS: FieldFactory[] = [
  name, merge, label, group, putty, host, port,
  root, agent, username, password, privateKeyPath, passphrase,
  sftpCommand, sftpSudo, terminalCommand, taskCommand,
  PROXY_FIELD];
