import { readFile } from 'fs';
import { Socket } from 'net';
import { Client, ConnectConfig, SFTPWrapper as SFTPWrapperReal } from 'ssh2';
import { SFTPStream } from 'ssh2-streams';
import * as vscode from 'vscode';
import { loadConfigs, openConfigurationEditor } from './config';
import { FileSystemConfig } from './manager';
import * as proxy from './proxy';
import { getSession as getPuttySession } from './putty';
import { toPromise } from './toPromise';

// tslint:disable-next-line:variable-name
const SFTPWrapper = require('ssh2/lib/SFTPWrapper') as (new (stream: SFTPStream) => SFTPWrapperReal);
type SFTPWrapper = SFTPWrapperReal;

const DEFAULT_CONFIG: ConnectConfig = {
  tryKeyboard: true,
  keepaliveInterval: 30e3,
};

function replaceVariables(string?: string) {
  if (typeof string !== 'string') return string;
  return string.replace(/\$\w+/g, key => process.env[key.substr(1)] || '');
}

export async function calculateActualConfig(config: FileSystemConfig): Promise<FileSystemConfig | null> {
  config = { ...config };
  if ('_calculated' in config) return config;
  (config as any)._calculated = true;
  config.username = replaceVariables(config.username);
  config.host = replaceVariables(config.host);
  const port = replaceVariables((config.port || '') + '');
  if (port) config.port = Number(port);
  config.agent = replaceVariables(config.agent) || process.env.SSH_AUTH_SOCK;
  config.privateKeyPath = replaceVariables(config.privateKeyPath);
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
    config.username = config.username || session.username;
    if (!config.username && session.hostname && session.hostname.indexOf('@') >= 1) {
      config.username = session.hostname.substr(0, session.hostname.indexOf('@'));
    }
    config.host = config.host || session.hostname;
    config.port = session.portnumber || config.port;
    config.agent = config.agent || (session.tryagent ? 'pageant' : undefined);
    if (session.usernamefromenvironment) {
      config.username = process.env.USERNAME || process.env.USER;
      if (!config.username) throw new Error(`Trying to use the system username, but process.env.USERNAME or process.env.USER is missing`);
    }
    config.privateKeyPath = config.privateKeyPath || (!config.agent && session.publickeyfile) || undefined;
    switch (session.proxymethod) {
      case 0:
        break;
      case 1:
      case 2:
      case 3:
        if (!session.proxyhost) throw new Error(`Proxymethod is SOCKS 4/5 or HTTP but 'proxyhost' is missing`);
        config.proxy = {
          host: session.proxyhost,
          port: session.proxyport,
          type: session.proxymethod === 1 ? 'socks4' : (session.proxymethod === 2 ? 'socks5' : 'http'),
        };
        break;
      default:
        throw new Error(`The requested PuTTY session uses an unsupported proxy method`);
    }
  }
  if (config.privateKeyPath) {
    try {
      const key = await toPromise<Buffer>(cb => readFile(config.privateKeyPath!, cb));
      config.privateKey = key;
    } catch (e) {
      throw new Error(`Error while reading the keyfile at:\n${config.privateKeyPath}`);
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
  if (config.hop) {
    const hop = loadConfigs().find(c => c.name === config.hop);
    if (!hop) throw new Error(`A SSH FS configuration with the name '${config.hop}' doesn't exist`);
    const ssh = await createSSH(hop);
    if (!ssh) return null;
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      ssh.forwardOut('localhost', 0, config.host!, config.port || 22, (err, channel) => {
        if (err) {
          err.message = `Couldn't connect through the hop:\n${err.message}`;
          return reject(err);
        }
        channel.once('close', () => ssh.destroy());
        resolve(channel);
      });
    });
  }
  switch (config.proxy && config.proxy.type) {
    case null:
    case undefined:
      break;
    case 'socks4':
    case 'socks5':
      return await proxy.socks(config);
    case 'http':
      return await proxy.http(config);
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
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      Promise.all<string>(prompts.map(prompt =>
        vscode.window.showInputBox({
          password: true, // prompt.echo was false for me while testing password prompting
          ignoreFocusOut: true,
          prompt: prompt.prompt.replace(/:\s*$/, ''),
        }),
      )).then(finish);
    });
    client.once('error', (error) => {
      if (error.description) {
        error.message = `${error.description}\n${error.message}`;
      }
      reject(error);
    });
    try {
      client.connect(Object.assign<ConnectConfig, ConnectConfig, ConnectConfig>(config, { sock }, DEFAULT_CONFIG));
    } catch (e) {
      reject(e);
    }
  });
}

export function getSFTP(client: Client, config: FileSystemConfig): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    if (!config.sftpCommand) {
      return client.sftp((err, sftp) => {
        if (err) {
          client.end();
          reject(err);
        }
        resolve(sftp);
      });
    }
    client.exec(config.sftpCommand, (err, channel) => {
      if (err) {
        client.end();
        return reject(err);
      }
      channel.once('close', () => (client.end(), reject()));
      channel.once('error', () => (client.end(), reject()));
      try {
        const sftps = new SFTPStream();
        channel.pipe(sftps).pipe(channel);
        const sftp = new SFTPWrapper(sftps);
        resolve(sftp);
      } catch (e) {
        reject(e);
      }
    });
  });
}
