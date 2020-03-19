import { readFile } from 'fs';
import { Socket } from 'net';
import { Client, ClientChannel, ConnectConfig, SFTPWrapper as SFTPWrapperReal } from 'ssh2';
import { SFTPStream } from 'ssh2-streams';
import * as vscode from 'vscode';
import { getConfigs } from './config';
import { FileSystemConfig } from './fileSystemConfig';
import * as Logging from './logging';
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
  if ('_calculated' in config) return config;
  config = { ...config };
  (config as any)._calculated = true;
  config.username = replaceVariables(config.username);
  config.host = replaceVariables(config.host);
  const port = replaceVariables((config.port || '') + '');
  if (port) config.port = Number(port);
  config.agent = replaceVariables(config.agent);
  config.privateKeyPath = replaceVariables(config.privateKeyPath);
  Logging.info(`[${config.name}] Calculating actual config`);
  if (config.putty) {
    if (process.platform !== 'win32') {
      Logging.warning(`[${config.name}] \tConfigurating uses putty, but platform is ${process.platform}`);
    }
    let nameOnly = true;
    if (config.putty === true) {
      if (!config.host) throw new Error(`'putty' was true but 'host' is empty/missing`);
      config.putty = config.host;
      nameOnly = false;
    } else {
      config.putty = replaceVariables(config.putty);
    }
    const session = await (await import('./putty')).getSession(config.putty, config.host, config.username, nameOnly);
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
    Logging.debug(`[${config.name}] \tReading PuTTY configuration lead to the following configuration:\n${JSON.stringify(config, null, 4)}`);
  }
  if (config.privateKeyPath) {
    try {
      const key = await toPromise<Buffer>(cb => readFile(config.privateKeyPath!, cb));
      config.privateKey = key;
      Logging.debug(`[${config.name}] \tRead private key from ${config.privateKeyPath}`);
    } catch (e) {
      throw new Error(`Error while reading the keyfile at:\n${config.privateKeyPath}`);
    }
  }
  if (!config.username || (config.username as any) === true) {
    config.username = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: 'Username',
      prompt: `Username for ${config.name}`,
    });
  }
  if ((config.password as any) === true) {
    config.password = await vscode.window.showInputBox({
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Password',
      prompt: `Password for ${config.username}@${config.name}`,
    });
  }
  if (config.password) config.agent = undefined;
  if ((config.passphrase as any) === true) {
    if (config.privateKey) {
      config.passphrase = await vscode.window.showInputBox({
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Passphrase',
        prompt: `Passphrase for provided export/private key for ${config.username}@${config.name}`,
      });
    } else {
      const answer = await vscode.window.showWarningMessage(
        `The field 'passphrase' was set to true, but no key was provided for ${config.username}@${config.name}`, /*'Configure',*/ 'Ignore');
      /*if (answer === 'Configure') {
        // TODO: Link up with new UI flow (can't directly access manager.openSettings() here)
        openConfigurationEditor(config.name);
        return null;
      }*/
    }
  } else if ((config.passphrase as any) === false) {
    // Issue with the ssh2 dependency apparently not liking false
    delete config.passphrase;
  }
  Logging.debug(`[${config.name}] \tFinal configuration:\n${JSON.stringify(Logging.censorConfig(config), null, 4)}`);
  return config;
}

export async function createSocket(config: FileSystemConfig): Promise<NodeJS.ReadableStream | null> {
  config = (await calculateActualConfig(config))!;
  if (!config) return null;
  Logging.info(`[${config.name}] Creating socket`);
  if (config.hop) {
    Logging.debug(`\tHopping through ${config.hop}`);
    const hop = getConfigs().find(c => c.name === config.hop);
    if (!hop) throw new Error(`A SSH FS configuration with the name '${config.hop}' doesn't exist`);
    const ssh = await createSSH(hop);
    if (!ssh) {
      Logging.debug(`[${config.name}] \tFailed in connecting to hop ${config.hop}`);
      return null;
    }
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      ssh.forwardOut('localhost', 0, config.host!, config.port || 22, (err, channel) => {
        if (err) {
          Logging.debug(`\tError connecting to hop ${config.hop} for ${config.name}: ${err}`);
          err.message = `Couldn't connect through the hop:\n${err.message}`;
          return reject(err);
        } else if (!channel) {
          err = new Error('Did not receive a channel');
          Logging.debug(`\tGot no channel when connecting to hop ${config.hop} for ${config.name}`);
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
      return await (await import('./proxy')).socks(config);
    case 'http':
      return await (await import('./proxy')).http(config);
    default:
      throw new Error(`Unknown proxy method`);
  }
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    Logging.debug(`[${config.name}] Connecting to ${config.host}:${config.port || 22}`);
    const socket = new Socket();
    socket.connect(config.port || 22, config.host!, () => resolve(socket as NodeJS.ReadableStream));
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
      Logging.debug(`[${config.name}] Received keyboard-interactive request with prompts "${JSON.stringify(prompts)}"`);
      Promise.all<string>(prompts.map(prompt =>
        vscode.window.showInputBox({
          password: true, // prompt.echo was false for me while testing password prompting
          ignoreFocusOut: true,
          prompt: prompt.prompt.replace(/:\s*$/, ''),
        }),
      )).then(finish);
    });
    client.on('error', (error: Error & { description?: string }) => {
      if (error.description) {
        error.message = `${error.description}\n${error.message}`;
      }
      Logging.error(`[${config.name}] ${error.message || error}`);
      reject(error);
    });
    try {
      Logging.info(`[${config.name}] Creating SSH session over the opened socket`);
      client.connect(Object.assign<ConnectConfig, ConnectConfig, ConnectConfig>(config, { sock }, DEFAULT_CONFIG));
    } catch (e) {
      reject(e);
    }
  });
}

function startSudo(shell: ClientChannel, config: FileSystemConfig, user: string | boolean = true): Promise<void> {
  Logging.debug(`[${config.name}] Turning shell into a sudo shell for ${typeof user === 'string' ? `'${user}'` : 'default sudo user'}`);
  return new Promise((resolve, reject) => {
    function stdout(data: Buffer | string) {
      data = data.toString();
      if (data.trim() === 'SUDO OK') {
        return cleanup(), resolve();
      } else {
        Logging.debug(`[${config.name}] Unexpected STDOUT: ${data}`);
      }
    }
    async function stderr(data: Buffer | string) {
      data = data.toString();
      if (data.match(/^\[sudo\]/)) {
        const password = typeof config.password === 'string' ? config.password :
          await vscode.window.showInputBox({
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'Password',
            prompt: data.substr(7),
          });
        if (!password) return cleanup(), reject(new Error('No password given'));
        return shell.write(`${password}\n`);
      }
      return cleanup(), reject(new Error(`Sudo error: ${data}`));
    }
    function cleanup() {
      shell.stdout.removeListener('data', stdout);
      shell.stderr.removeListener('data', stderr);
    }
    shell.stdout.on('data', stdout);
    shell.stderr.on('data', stderr);
    const uFlag = typeof user === 'string' ? `-u ${user} ` : '';
    shell.write(`sudo -S ${uFlag}bash -c "echo SUDO OK; cat | bash"\n`);
  });
}

function stripSudo(cmd: string) {
  cmd = cmd.replace(/^sudo\s+/, '');
  let res = cmd;
  while (true) {
    cmd = res.trim();
    res = cmd.replace(/^\-\-\s+/, '');
    if (res !== cmd) break;
    res = cmd.replace(/^\-[AbEeKklnPSsVv]/, '');
    if (res !== cmd) continue;
    res = cmd.replace(/^\-[CHhprtUu]\s+\S+/, '');
    if (res !== cmd) continue;
    res = cmd.replace(/^\-\-(close\-from|group|host|role|type|other\-user|user)=\S+/, '');
    if (res !== cmd) continue;
    break;
  }
  return cmd;
}

export async function getSFTP(client: Client, config: FileSystemConfig): Promise<SFTPWrapper> {
  config = (await calculateActualConfig(config))!;
  if (!config) throw new Error('Couldn\'t calculate the config');
  if (config.sftpSudo && !config.sftpCommand) {
    Logging.warning(`[${config.name}] sftpSudo is set without sftpCommand. Assuming /usr/lib/openssh/sftp-server`);
    config.sftpCommand = '/usr/lib/openssh/sftp-server';
  }
  if (!config.sftpCommand) {
    Logging.info(`[${config.name}] Creating SFTP session using standard sftp subsystem`);
    return toPromise<SFTPWrapper>(cb => client.sftp(cb));
  }
  let cmd = config.sftpCommand;
  Logging.info(`[${config.name}] Creating SFTP session using specified command: ${cmd}`);
  const shell = await toPromise<ClientChannel>(cb => client.shell(false, cb));
  // shell.stdout.on('data', (d: string | Buffer) => Logging.debug(`[${config.name}][SFTP-STDOUT] ${d}`));
  // shell.stderr.on('data', (d: string | Buffer) => Logging.debug(`[${config.name}][SFTP-STDERR] ${d}`));
  // Maybe the user hasn't specified `sftpSudo`, but did put `sudo` in `sftpCommand`
  // I can't find a good way of differentiating welcome messages, SFTP traffic, sudo password prompts, ...
  // so convert the `sftpCommand` to make use of `sftpSudo`, since that seems to work
  if (cmd.match(/^sudo/)) {
    // If the -u flag is given, use that too
    const mat = cmd.match(/\-u\s+(\S+)/) || cmd.match(/\-\-user=(\S+)/);
    config.sftpSudo = mat ? mat[1] : true;
    // Now the tricky part of splitting the sudo and sftp command
    config.sftpCommand = cmd = stripSudo(cmd);
    Logging.warning(`[${config.name}] Reformed sftpCommand due to sudo to: ${cmd}`);
  }
  // If the user wants sudo, we'll first convert this shell into a sudo shell
  if (config.sftpSudo) await startSudo(shell, config, config.sftpSudo);
  shell.write(`echo SFTP READY\n`);
  // Wait until we see "SFTP READY" (skipping welcome messages etc)
  await new Promise((ready, nvm) => {
    const handler = (data: string | Buffer) => {
      if (data.toString().trim() !== 'SFTP READY') return;
      shell.stdout.removeListener('data', handler);
      ready();
    };
    shell.stdout.on('data', handler);
    shell.on('close', nvm);
  });
  // Start sftpCommand (e.g. /usr/lib/openssh/sftp-server) and wrap everything nicely
  const sftps = new SFTPStream({ debug: config.debug });
  shell.pipe(sftps).pipe(shell);
  const sftp = new SFTPWrapper(sftps);
  await toPromise(cb => shell.write(`${cmd}\n`, cb));
  return sftp;
}
