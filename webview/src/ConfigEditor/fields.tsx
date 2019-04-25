import * as React from 'react';
import { FieldDropdown } from 'src/FieldTypes/dropdown';
import { FieldDropdownWithInput } from 'src/FieldTypes/dropdownwithinput';
import { FieldNumber } from 'src/FieldTypes/number';
import { FieldPath } from 'src/FieldTypes/path';
import { FieldString } from 'src/FieldTypes/string';
import { FileSystemConfig, invalidConfigName } from 'src/types/fileSystemConfig';
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
  const callback = (value?: string) => onChange('label', value);
  const description = 'Label to display in some UI places (e.g. popups)';
  return <FieldString key="label" label="Label" value={config.label} onChange={callback} optional={true} description={description} />
}

export function group(config: FileSystemConfig, onChange: FSCChanged<'group'>): React.ReactElement {
  const callback = (newValue: string) => onChange('group', newValue);
  const description = 'Group for this config, to group configs together in some UI places. Allows subgroups, in the format "Group1.SubGroup1.Subgroup2"';
  return <FieldConfigGroup key="group" label="Group" value={config.group} {...{ description }} onChange={callback} optional={true} />
}

export function putty(config: FileSystemConfig, onChange: FSCChanged<'putty'>): React.ReactElement {
  const callback = (newValue: string) => onChange('putty', newValue === '<Auto-detect>' ? true : newValue);
  const description = 'A name of a PuTTY session, or `true` to find the PuTTY session from the host address';
  const values = ['<Auto-detect>'];
  const value = config.putty === true ? '<Auto-detect>' : config.putty || undefined;
  return <FieldDropdownWithInput key="putty" label="PuTTY" {...{ value, values, description }} onChange={callback} optional={true} />
}

export function host(config: FileSystemConfig, onChange: FSCChanged<'host'>): React.ReactElement {
  const callback = (value?: string) => onChange('host', value);
  const description = 'Hostname or IP address of the server. Supports environment variables, e.g. $HOST';
  return <FieldString key="host" label="Host" value={config.host} onChange={callback} optional={true} description={description} />
}

export function port(config: FileSystemConfig, onChange: FSCChanged<'port'>): React.ReactElement {
  const callback = (value: number) => onChange('port', value);
  const description = 'Port number of the server. Supports environment variables, e.g. $PORT';
  return <FieldNumber key="port" label="Port" value={config.port} onChange={callback} optional={true} description={description} />
}

export function root(config: FileSystemConfig, onChange: FSCChanged<'root'>): React.ReactElement {
  const callback = (value: string) => onChange('root', value);
  const description = 'Path on the remote server where the root path in vscode should point to. Defaults to /';
  return <FieldString key="root" label="Root" value={config.root} onChange={callback} optional={true} validator={pathValidator} description={description} />
}

export function agent(config: FileSystemConfig, onChange: FSCChanged<'agent'>): React.ReactElement {
  const callback = (newValue: string) => onChange('agent', newValue === 'pageant' ? (true as any) : newValue);
  const description = `Path to ssh-agent's UNIX socket for ssh-agent-based user authentication. Supports 'pageant' for PuTTY's Pagent, and environment variables, e.g. $SSH_AUTH_SOCK`;
  const values = ['pageant', '//./pipe/openssh-ssh-agent', '$SSH_AUTH_SOCK'];
  const value = (config.agent as any) === true ? 'pageant' : config.agent;
  return <FieldDropdownWithInput key="agent" label="Agent" {...{ value, values, description }} onChange={callback} optional={true} />
}

export function username(config: FileSystemConfig, onChange: FSCChanged<'username'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('username', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Username for authentication. Supports environment variables, e.g. $USERNAME';
  const values = ['<Prompt>'];
  const value = (config.username as any) === true ? '<Prompt>' : config.username;
  return <FieldDropdownWithInput key="username" label="Username" {...{ value, values, description }} onChange={callback} optional={true} />
}

export function password(config: FileSystemConfig, onChange: FSCChanged<'password'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('password', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Password for password-based user authentication. Supports env variables. This gets saved in plaintext! Using prompts or private keys is recommended!';
  const values = ['<Prompt>'];
  const value = (config.password as any) === true ? '<Prompt>' : config.password;
  return <FieldDropdownWithInput key="password" label="Password" {...{ value, values, description }} onChange={callback} optional={true} />
}

export function privateKeyPath(config: FileSystemConfig, onChange: FSCChanged<'privateKeyPath'>): React.ReactElement {
  const callback = (value?: string) => onChange('privateKeyPath', value);
  const description = 'A path to a private key. Supports environment variables, e.g. `$HOMEDRIVE$HOMEPATH/.ssh/myKey.ppk` or `$HOME/.ssh/myKey`';
  return <FieldPath key="privateKeyPath" label="Private key" value={config.privateKeyPath} onChange={callback} optional={true} description={description} />
}

export function passphrase(config: FileSystemConfig, onChange: FSCChanged<'passphrase'>): React.ReactElement {
  const callback = (newValue?: string) => onChange('passphrase', newValue === '<Prompt>' ? (true as any) : newValue);
  const description = 'Passphrase for unlocking an encrypted private key. Supports env variables. This gets saved in plaintext! Using prompts or private keys is recommended!';
  const values = ['<Prompt>'];
  const value = (config.passphrase as any) === true ? '<Prompt>' : config.passphrase;
  return <FieldDropdownWithInput key="passphrase" label="Passphrase" {...{ value, values, description }} onChange={callback} optional={true} />
}

export type FieldFactory = (config: FileSystemConfig, onChange: FSCChanged, onChangeMultiple: FSCChangedMultiple) => React.ReactElement | null;
export const FIELDS: FieldFactory[] = [
  name, merge, label, group, putty, host, port,
  root, agent, username, password, privateKeyPath, passphrase,
  PROXY_FIELD];
