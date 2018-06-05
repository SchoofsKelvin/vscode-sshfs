import { readFile } from 'fs';
import { Socket } from 'net';
import { Client, ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';
import { loadConfigs, openConfigurationEditor } from './config';
import { FileSystemConfig } from './manager';
import * as proxy from './proxy';
import { getSession as getPuttySession } from './putty';
import { toPromise } from './toPromise';

function replaceVariables(string?: string) {
  if (typeof string !== 'string') return string;
  return string.replace(/\$\w+/g, key => process.env[key.substr(1)] || '');
}

export async function calculateActualConfig(config: FileSystemConfig): Promise<FileSystemConfig | null> {
  config = { ...config };
  if ('_calculated' in config) return config;
  (config as any)._calculated = true;
  if (config.putty) {
    let nameOnly = true;
    if (config.putty === true) {
      if (!config.host) throw new Error(`'putty' was true but 'host' is empty/missing`);
      config.putty = config.host;
      nameOnly = false;
    } else {
      config.putty = replaceVariables(config.putty);
    }
    const session = await getPuttySession(config.putty, config.host, config.username, nameOnly);
    if (!session) throw new Error(`Couldn't find the requested PuTTY session`);
    if (session.protocol !== 'ssh') throw new Error(`The requested PuTTY session isn't a SSH session`);
    config.username = replaceVariables(config.username) || session.username;
    config.host = replaceVariables(config.host) || session.hostname;
    const port = replaceVariables((config.port || '') + '') || session.portnumber;
    if (port) config.port = Number(port);
    config.agent = replaceVariables(config.agent) || (session.tryagent ? 'pageant' : undefined);
    if (session.usernamefromenvironment) {
      config.username = process.env.USERNAME;
      if (!config.username) throw new Error(`Trying to use the system username, but process.env.USERNAME is missing`);
    }
    const keyPath = replaceVariables(config.privateKeyPath) || (!config.agent && session.publickeyfile);
    if (keyPath) {
      try {
        const key = await toPromise<Buffer>(cb => readFile(keyPath, cb));
        config.privateKey = key;
      } catch (e) {
        throw new Error(`Error while reading the keyfile at:\n${keyPath}`);
      }
    }
    switch (session.proxymethod) {
      case 0:
        break;
      case 1:
      case 2:
        if (!session.proxyhost) throw new Error(`Proxymethod is SOCKS 4/5 but 'proxyhost' is missing`);
        config.proxy = {
          host: session.proxyhost,
          port: session.proxyport,
          type: session.proxymethod === 1 ? 'socks4' : 'socks5',
        };
        break;
      default:
        throw new Error(`The requested PuTTY session uses an unsupported proxy method`);
    }
  }
  if (!config.username || (config.username as any) === true) {
    config.username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: 'Username',
      prompt: 'Username to log in with',
    });
  }
  if ((config.password as any) === true) {
    config.password = await vscode.window.showInputBox({
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Password',
      prompt: 'Password for the provided username',
    });
  }
  if (config.password) config.agent = undefined;
  if ((config.passphrase as any) === true) {
    if (config.privateKey) {
      config.passphrase = await vscode.window.showInputBox({
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Passphrase',
        prompt: 'Passphrase for the provided export/private key',
      });
    } else {
      const answer = await vscode.window.showWarningMessage(`The field 'passphrase' was set to true, but no key was provided`, 'Configure', 'Ignore');
      if (answer === 'Configure') {
        openConfigurationEditor(config.name);
        return null;
      }
    }
  }
  if (config.password) config.agent = undefined;
  return config;
}

export async function createSocket(config: FileSystemConfig): Promise<NodeJS.ReadableStream | null> {
  config = (await calculateActualConfig(config))!;
  if (!config) return null;
  switch (config.proxy && config.proxy.type) {
    case null:
    case undefined:
      break;
    case 'socks4':
    case 'socks5':
      return await proxy.socks(config);
    default:
      throw new Error(`Unknown proxy method`);
  }
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    const socket = new Socket();
    socket.connect(config.port || 22, config.host, () => resolve(socket as NodeJS.ReadableStream));
    socket.once('error', reject);
  });
}

export async function createSSH(config: FileSystemConfig, sock?: NodeJS.ReadableStream): Promise<Client | null> {
  config = (await calculateActualConfig(config))!;
  if (!config) return null;
  sock = sock || (await createSocket(config))!;
  if (!sock) return null;
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => resolve(client));
    client.once('timeout', () => reject(new Error(`Socket timed out while connecting SSH FS '${config.name}'`)));
    client.once('error', (error) => {
      if (error.description) {
        error.message = `${error.description}\n${error.message}`;
      }
      reject(error);
    });
    try {
      client.connect(Object.assign<ConnectConfig, ConnectConfig>(config, { sock, tryKeyboard: false }));
    } catch (e) {
      reject(e);
    }
  });
}
