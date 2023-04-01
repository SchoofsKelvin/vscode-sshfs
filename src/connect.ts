import type { FileSystemConfig } from 'common/fileSystemConfig';
import { readFile } from 'fs';
import { Socket } from 'net';
import { userInfo } from 'os';
import { AuthHandlerFunction, AuthHandlerObject, Client, ClientChannel, ConnectConfig } from 'ssh2';
import { SFTP } from 'ssh2/lib/protocol/SFTP';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { getFlagBoolean } from './flags';
import { Logger, Logging } from './logging';
import type { PuttySession } from './putty';
import { toPromise, validatePort } from './utils';

const DEFAULT_CONFIG: ConnectConfig = {
  tryKeyboard: true,
  keepaliveInterval: 30e3,
};

function replaceVariables(string?: string) {
  if (typeof string !== 'string') return string;
  return string.replace(/\$\w+/g, key => process.env[key.substr(1)] || '');
}

const PROMPT_FIELDS: Partial<Record<keyof FileSystemConfig, [
  placeholder: string,
  prompt: (config: FileSystemConfig) => string,
  promptOnEmpty: boolean, password?: boolean]>> = {
  host: ['Host', c => `Host for ${c.name}`, true],
  username: ['Username', c => `Username for ${c.name}`, true],
  password: ['Password', c => `Password for '${c.username}' for ${c.name}`, false, true],
  passphrase: ['Passphrase', c => `Passphrase for provided export/private key for '${c.username}' for ${c.name}`, false, true],
};

async function promptFields(config: FileSystemConfig, ...fields: (keyof FileSystemConfig)[]): Promise<void> {
  for (const field of fields) {
    const prompt = PROMPT_FIELDS[field];
    if (!prompt) {
      Logging.error`Prompting unexpected field '${field}'`;
      continue;
    }
    const value = config[field];
    if (value && value !== true) continue; // Truthy and not true
    if (!value && !prompt[2]) continue; // Falsy but not promptOnEmpty
    const result = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      password: !!prompt[3],
      placeHolder: prompt[0],
      prompt: prompt[1](config),
    });
    (config[field] as string | undefined) = result;
  }
}

export async function calculateActualConfig(config: FileSystemConfig): Promise<FileSystemConfig | null> {
  if (config._calculated) return config;
  const logging = Logging.scope();
  // Add the internal _calculated field to cache the actual config for the next calculateActualConfig call
  // (and it also allows accessing the original config that generated this actual config, if ever necessary)
  config = { ...config, _calculated: config };
  // Windows uses `$USERNAME` while Unix uses `$USER`, let's normalize it here
  if (config.username === '$USERNAME') config.username = '$USER';
  // Delay handling just `$USER` until later, as PuTTY might handle it specially
  if (config.username !== '$USER') config.username = replaceVariables(config.username);
  config.host = replaceVariables(config.host);
  const port = replaceVariables((config.port || '') + '');
  config.port = port ? validatePort(port) : 22;
  config.agent = replaceVariables(config.agent);
  config.privateKeyPath = replaceVariables(config.privateKeyPath);
  logging.info`Calculating actual config`;
  if (config.instantConnection) {
    // Created from an instant connection string, so enable PuTTY (in try mode)
    config.putty = '<TRY>'; // Could just set it to `true` but... consistency?
  }
  if (config.putty) {
    if (process.platform !== 'win32') {
      logging.warning(`\tConfigurating uses putty, but platform is ${process.platform}`);
    }
    const { getCachedFinder } = await import('./putty');
    const getSession = await getCachedFinder();
    const cUsername = config.username === '$USER' ? undefined : config.username;
    const tryPutty = config.instantConnection || config.putty === '<TRY>';
    let session: PuttySession | undefined;
    if (tryPutty) {
      // If we're trying to find one, we also check whether `config.host` represents the name of a PuTTY session
      session = await getSession(config.host);
      logging.info`\ttryPutty is true, tried finding a config named '${config.host}' and found ${session ? `'${session.name}'` : 'no match'}`;
    }
    if (!session) {
      let nameOnly = true;
      if (config.putty === true) {
        await promptFields(config, 'host');
        // TODO: `config.putty === true` without config.host should prompt the user with *all* PuTTY sessions
        if (!config.host) throw new Error(`'putty' was true but 'host' is empty/missing`);
        config.putty = config.host;
        nameOnly = false;
      } else {
        config.putty = replaceVariables(config.putty);
      }
      session = await getSession(config.putty, config.host, cUsername, nameOnly);
    }
    if (session) {
      if (session.protocol !== 'ssh') throw new Error(`The requested PuTTY session isn't a SSH session`);
      config.username = cUsername || session.username;
      if (!config.username && session.hostname && session.hostname.indexOf('@') >= 1) {
        config.username = session.hostname.substr(0, session.hostname.indexOf('@'));
      }
      // Used to be `config.host || session.hostname`, but `config.host` could've been just the session name
      config.host = session.hostname.replace(/^.*?@/, '');
      config.port = session.portnumber || config.port;
      config.agent = config.agent || (session.tryagent ? 'pageant' : undefined);
      if (session.usernamefromenvironment) config.username = '$USER';
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
      logging.debug`\tReading PuTTY configuration lead to the following configuration:\n${JSON.stringify(config, null, 4)}`;
    } else if (!tryPutty) {
      throw new Error(`Couldn't find the requested PuTTY session`);
    } else {
      logging.debug`\tConfig suggested finding a PuTTY configuration, did not find one`;
    }
  }
  // If the username is (still) `$USER` at this point, use the local user's username
  if (config.username === '$USER') config.username = userInfo().username;
  if (config.privateKeyPath) {
    try {
      const key = await toPromise<Buffer>(cb => readFile(config.privateKeyPath!, cb));
      config.privateKey = key;
      logging.debug`\tRead private key from ${config.privateKeyPath}`;
    } catch (e) {
      throw new Error(`Error while reading the keyfile at:\n${config.privateKeyPath}`);
    }
  }
  await promptFields(config, 'host', 'username', 'password');
  if (config.password) config.agent = undefined;
  if ((config.passphrase as any) === true) {
    if (config.privateKey) {
      await promptFields(config, 'passphrase');
    } else {
      const answer = await vscode.window.showWarningMessage(
        `The field 'passphrase' was set to true, but no key was provided for ${config.username}@${config.name}`, 'Configure', 'Ignore');
      if (answer === 'Configure') {
        const webview = await import('./webview');
        webview.navigate({ type: 'editconfig', config });
        return null;
      }
    }
  } else if ((config.passphrase as any) === false) {
    // Issue with the ssh2 dependency apparently not liking false
    delete config.passphrase;
  }
  if (config.agentForward && !config.agent) {
    logging.debug`\tNo agent while having agentForward, disabling agent forwarding`;
    config.agentForward = false;
  }
  if (!config.privateKey && !config.agent && !config.password) {
    logging.debug`\tNo privateKey, agent or password. Gonna prompt for password`;
    config.password = true as any;
    await promptFields(config, 'password');
  }
  logging.debug`\tFinal configuration:\n${config}`;
  return config;
}

export async function createSocket(config: FileSystemConfig): Promise<NodeJS.ReadableStream | null> {
  config = (await calculateActualConfig(config))!;
  if (!config) return null;
  const logging = Logging.scope(`createSocket(${config.name})`);
  logging.info`Creating socket`;
  if (config.hop) {
    logging.debug`\tHopping through ${config.hop}`;
    const hop = getConfig(config.hop);
    if (!hop) throw new Error(`A SSH FS configuration with the name '${config.hop}' doesn't exist`);
    const ssh = await createSSH(hop);
    if (!ssh) {
      logging.debug`\tFailed in connecting to hop ${config.hop}`;
      return null;
    }
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      ssh.forwardOut('localhost', 0, config.host!, config.port || 22, (err, channel) => {
        if (err) {
          logging.debug`\tError connecting to hop ${config.hop} for ${config.name}: ${err}`;
          err.message = `Couldn't connect through the hop:\n${err}`;
          return reject(err);
        } else if (!channel) {
          err = new Error('Did not receive a channel');
          logging.debug`\tGot no channel when connecting to hop ${config.hop} for ${config.name}`;
          return reject(err);
        }
        channel.once('close', () => ssh.end());
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
    logging.debug`Connecting to ${config.host}:${config.port || 22}`;
    const socket = new Socket();
    socket.connect(config.port || 22, config.host!, () => resolve(socket as NodeJS.ReadableStream));
    socket.once('error', reject);
  });
}

function makeAuthHandler(config: FileSystemConfig, logging: Logger): AuthHandlerFunction {
  const authsAllowed: (AuthHandlerObject | AuthHandlerObject['type'])[] = ['none'];
  const [flagV, flagR] = getFlagBoolean('OPENSSH-SHA1', true, config.flags);
  if (config.password) authsAllowed.push('password');
  if (config.privateKey) {
    if (flagV) {
      logging.info`Flag "OPENSSH-SHA1" enabled due to '${flagR}', including convertSha1 for publickey authentication`;
      authsAllowed.push({ type: 'publickey', username: config.username!, key: config.privateKey, convertSha1: true });
    } else {
      authsAllowed.push('publickey');
    }
  }
  if (config.agent) {
    if (flagV) {
      logging.info`Flag "OPENSSH-SHA1" enabled due to '${flagR}', including convertSha1 for agent authentication`;
      authsAllowed.push({ type: 'agent', username: config.username!, agent: config.agent, convertSha1: true });
    } else {
      authsAllowed.push('agent');
    }
  }
  if (config.tryKeyboard) authsAllowed.push('keyboard-interactive');
  if (config.privateKey && config.localHostname && config.localUsername) authsAllowed.push('hostbased');
  if (flagV) {
    logging.info`Flag "OPENSSH-SHA1" enabled due to '${flagR}'`;
  }
  return () => authsAllowed.shift() || false;
}

export async function createSSH(config: FileSystemConfig, sock?: NodeJS.ReadableStream): Promise<Client | null> {
  config = (await calculateActualConfig(config))!;
  if (!config) return null;
  sock = sock || (await createSocket(config))!;
  if (!sock) return null;
  const logging = Logging.scope(`createSSH(${config.name})`);
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => resolve(client));
    client.once('timeout', () => reject(new Error(`Socket timed out while connecting SSH FS '${config.name}'`)));
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      logging.debug`Received keyboard-interactive request with prompts ${prompts}`;
      Promise.all<string>(prompts.map(prompt =>
        vscode.window.showInputBox({
          password: true, // prompt.echo was false for me while testing password prompting
          ignoreFocusOut: true,
          prompt: prompt.prompt.replace(/:\s*$/, ''),
        }),
      )).then(finish).catch(e => logging.error(e));
    });
    client.on('error', (error: Error & { description?: string }) => {
      if (error.description) {
        error.message = `${error.description}\n${error}`;
      }
      logging.error(error);
      reject(error);
    });
    try {
      const finalConfig: FileSystemConfig = { ...config, sock, ...DEFAULT_CONFIG };
      finalConfig.authHandler = makeAuthHandler(finalConfig, logging);
      if (config.debug || getFlagBoolean('DEBUG_SSH2', false, config.flags)[0]) {
        const scope = Logging.scope(`ssh2(${config.name})`);
        finalConfig.debug = (msg: string) => scope.debug(msg);
      }
      // Unless the flag 'DF-GE' is specified, disable DiffieHellman groupex algorithms (issue #239)
      // Note: If the config already specifies a custom `algorithms.key`, ignore it (trust the user?)
      const [flagV, flagR] = getFlagBoolean('DF-GE', false, config.flags);
      if (flagV) {
        logging.info`Flag "DF-GE" enabled due to '${flagR}', disabling DiffieHellman kex groupex algorithms`;
        const removeKex = finalConfig.algorithms?.kex;
        if (removeKex) logging.debug`\tAlready present algorithms.kex: ${removeKex}`;
        finalConfig.algorithms = {
          ...finalConfig.algorithms,
          kex: {
            ...finalConfig.algorithms?.kex,
            remove: [
              ...(Array.isArray(removeKex) ? removeKex : []),
              'diffie-hellman-group-exchange',
            ],
          },
        };
        logging.debug`\tResulting algorithms.kex: ${finalConfig.algorithms.kex}`;
      }
      client.connect(finalConfig);
    } catch (e) {
      reject(e);
    }
  });
}

function startSudo(shell: ClientChannel, config: FileSystemConfig, user: string | boolean = true): Promise<void> {
  Logging.debug`Turning shell into a sudo shell for ${typeof user === 'string' ? `'${user}'` : 'default sudo user'}`;
  return new Promise((resolve, reject) => {
    function stdout(data: Buffer | string) {
      data = data.toString();
      if (data.trim() === 'SUDO OK') {
        return cleanup(), resolve();
      } else {
        Logging.debug`Unexpected STDOUT: ${data}`;
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
      shell.removeListener('data', stdout);
      shell.stderr!.removeListener('data', stderr);
    }
    shell.on('data', stdout);
    shell.stderr!.on('data', stderr);
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

export async function getSFTP(client: Client, config: FileSystemConfig): Promise<SFTP> {
  config = (await calculateActualConfig(config))!;
  if (!config) throw new Error('Couldn\'t calculate the config');
  const logging = Logging.scope(`getSFTP(${config.name})`);
  if (config.sftpSudo && !config.sftpCommand) {
    logging.warning(`sftpSudo is set without sftpCommand. Assuming /usr/lib/openssh/sftp-server`);
    config.sftpCommand = '/usr/lib/openssh/sftp-server';
  }
  if (!config.sftpCommand) {
    logging.info`Creating SFTP session using standard sftp subsystem`;
    return toPromise<SFTP>(cb => client.sftp(cb));
  }
  let cmd = config.sftpCommand;
  logging.info`Creating SFTP session using specified command: ${cmd}`;
  const shell = await toPromise<ClientChannel>(cb => client.shell(false, cb));
  // shell.stdout.on('data', (d: string | Buffer) => logging.debug`[SFTP-STDOUT] ${d}`);
  // shell.stderr.on('data', (d: string | Buffer) => logging.debug`[SFTP-STDERR] ${d}`);
  // Maybe the user hasn't specified `sftpSudo`, but did put `sudo` in `sftpCommand`
  // I can't find a good way of differentiating welcome messages, SFTP traffic, sudo password prompts, ...
  // so convert the `sftpCommand` to make use of `sftpSudo`, since that seems to work
  if (cmd.match(/^sudo/)) {
    // If the -u flag is given, use that too
    const mat = cmd.match(/\-u\s+(\S+)/) || cmd.match(/\-\-user=(\S+)/);
    config.sftpSudo = mat ? mat[1] : true;
    // Now the tricky part of splitting the sudo and sftp command
    config.sftpCommand = cmd = stripSudo(cmd);
    logging.warning(`Reformed sftpCommand due to sudo to: ${cmd}`);
  }
  // If the user wants sudo, we'll first convert this shell into a sudo shell
  if (config.sftpSudo) await startSudo(shell, config, config.sftpSudo);
  shell.write(`echo SFTP READY\n`);
  // Wait until we see "SFTP READY" (skipping welcome messages etc)
  await new Promise<void>((ready, nvm) => {
    const handler = (data: string | Buffer) => {
      if (data.toString().trim() !== 'SFTP READY') return;
      shell.removeListener('data', handler);
      ready();
    };
    shell.on('data', handler);
    shell.on('close', nvm);
  });
  // Start sftpCommand (e.g. /usr/lib/openssh/sftp-server) and wrap everything nicely
  const sftp = new SFTP(client, shell, { debug: config.debug });
  shell.on('data', data => sftp.push(data));
  shell.on('close', data => data.end());
  await toPromise(cb => shell.write(`${cmd}\n`, cb));
  sftp._init();
  return sftp;
}
