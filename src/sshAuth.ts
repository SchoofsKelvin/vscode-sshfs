
import type { FileSystemConfig } from 'common/fileSystemConfig';
import { execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import { homedir, tmpdir, userInfo } from 'os';
import * as path from 'path';
import type { AuthHandlerFunction, AuthHandlerObject, KeyboardInteractiveListener } from 'ssh2';
import { BaseAgent, SignOptions, createAgent } from 'ssh2/lib/agent';
import { ParsedKey, parseKey } from 'ssh2/lib/protocol/keyParser';
import * as vscode from 'vscode';
import type { Logger } from './logging';

/*
 * OpenSSH-style authentication, used for hosts from an OpenSSH config file (and configs using `identityFiles`).
 *
 * The goal is to behave like `ssh` (and thus like e.g. the Remote - SSH extension, which runs `ssh`): every key
 * that is loaded in your SSH agent (i.e. listed by `ssh-add -l`) is used straight from the agent, without ever
 * needing the key file or its passphrase. A passphrase is only prompted as a last resort, for an encrypted key
 * file that is not loaded in the agent. Nothing that gets prompted is ever stored.
 */

/** State shared by a connection and all the hops/jump hosts it connects through */
export interface ConnectContext {
  /** How many hops deep we are */
  depth: number;
  /**
   * Keys that got decrypted while connecting, so that a jump host and the target sharing the same key only prompt
   * for its passphrase once. Only lives in memory for as long as this single connection attempt takes.
   */
  keys: Map<string, ParsedKey>;
  /** The SSH agents we already looked for during this connection attempt, by the agent the config asked for */
  agents?: Map<string, Promise<FoundAgent | undefined>>;
}

/** Shows the prompts of a keyboard-interactive authentication request to the user. The answers are never stored */
export function promptKeyboardInteractive(logging: Logger): KeyboardInteractiveListener {
  return (name, instructions, lang, prompts, finish) => {
    logging.debug`Received keyboard-interactive request with prompts ${prompts}`;
    Promise.all<string | undefined>(prompts.map(prompt =>
      vscode.window.showInputBox({
        password: true, // prompt.echo was false for me while testing password prompting
        ignoreFocusOut: true,
        prompt: prompt.prompt.replace(/:\s*$/, ''),
      }),
    )).then(finish as (answers: (string | undefined)[]) => void).catch(e => logging.error(e));
  };
}

function expandHome(file: string): string {
  if (file === '~') return homedir();
  if (file.startsWith('~/') || file.startsWith('~\\')) return path.join(homedir(), file.substring(2));
  return file;
}

/** `parseKey` can both return and throw errors, and (in theory) return multiple keys. This normalizes all of that */
function tryParseKey(data: Buffer | string, passphrase?: string): ParsedKey | Error {
  try {
    const parsed: ParsedKey | ParsedKey[] | Error = parseKey(data, passphrase);
    if (Array.isArray(parsed)) return parsed[0] || new Error('No key found');
    return parsed;
  } catch (e) {
    return e instanceof Error ? e : new Error(`${e}`);
  }
}

/**
 * Private keys in the OpenSSH format (`-----BEGIN OPENSSH PRIVATE KEY-----`, what `ssh-keygen` generates nowadays)
 * contain their public key unencrypted, even when the private part is protected by a passphrase. This extracts
 * that public key (in SSH wire format), which allows us to recognize the key in the SSH agent without its passphrase.
 */
export function readPublicKeyFromOpenSSHPrivateKey(data: Buffer | string): Buffer | undefined {
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(data.toString('latin1'));
  if (!match) return undefined;
  const blob = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  const magic = 'openssh-key-v1\0';
  if (blob.length < magic.length || blob.toString('latin1', 0, magic.length) !== magic) return undefined;
  let offset = magic.length;
  const readString = (): Buffer | undefined => {
    if (offset + 4 > blob.length) return undefined;
    const length = blob.readUInt32BE(offset);
    if (offset + 4 + length > blob.length) return undefined;
    offset += 4 + length;
    return blob.subarray(offset - length, offset);
  };
  // cipher name, KDF name, KDF options
  if (!readString() || !readString() || !readString()) return undefined;
  // Number of keys (always 1 in practice), followed by the public key(s)
  if (offset + 4 > blob.length || blob.readUInt32BE(offset) < 1) return undefined;
  offset += 4;
  const publicKey = readString();
  return publicKey && publicKey.length ? Buffer.from(publicKey) : undefined;
}

/** Tries to get the public key (in SSH wire format) for the given private key file, without needing its passphrase */
export async function readPublicKey(file: string, privateKeyData?: Buffer): Promise<Buffer | undefined> {
  try {
    const parsed = tryParseKey(await fsPromises.readFile(`${file}.pub`));
    if (!(parsed instanceof Error)) return parsed.getPublicSSH();
  } catch {
    // No (readable) .pub file next to the private key, fall back to the private key itself
  }
  try {
    const data = privateKeyData || await fsPromises.readFile(file);
    const parsed = tryParseKey(data);
    if (!(parsed instanceof Error)) return parsed.getPublicSSH();
    // Encrypted, but the OpenSSH format still has the public key in plain sight
    return readPublicKeyFromOpenSSHPrivateKey(data);
  } catch {
    // Unreadable
  }
  return undefined;
}

/* SSH agent discovery */

const WINDOWS_OPENSSH_AGENT = '\\\\.\\pipe\\openssh-ssh-agent';
const AGENT_TIMEOUT = 5000;

interface AgentCandidate {
  path: string;
  /** Where we got this path from, for logging purposes */
  source: string;
}

export interface FoundAgent extends AgentCandidate {
  agent: BaseAgent;
  /** The public keys (in SSH wire format) the agent has loaded, i.e. what `ssh-add -L` would list */
  keys: Buffer[];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout: 2000, windowsHide: true }, (error, stdout) => resolve(error ? '' : `${stdout}`.trim()));
    } catch {
      resolve('');
    }
  });
}

/** Lists the agent sockets (owned by us) in the given directory matching the pattern, most recently created first */
async function findSockets(directory: string, pattern: RegExp, uid: number): Promise<string[]> {
  const found: [file: string, time: number][] = [];
  try {
    for (const name of await fsPromises.readdir(directory)) {
      if (!pattern.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const stat = await fsPromises.stat(file);
        if (stat.isSocket() && (uid < 0 || stat.uid === uid)) found.push([file, stat.mtimeMs]);
      } catch {
        // Not accessible (anymore)
      }
    }
  } catch {
    // Directory doesn't exist or isn't accessible
  }
  return found.sort((a, b) => b[1] - a[1]).map(([file]) => file);
}

/**
 * Lists every place a SSH agent could be listening at, in order of preference:
 * - What the config asks for: `IdentityAgent`, or the `$SSH_AUTH_SOCK` VS Code got started with
 * - The standard agent of the platform (OpenSSH agent service / Pageant on Windows, launchd on macOS,
 *   the desktop keyring / systemd user service on Linux)
 * - Agents started by hand (e.g. `eval $(ssh-agent)` in a terminal). VS Code doesn't know about those when it
 *   wasn't started from that terminal, but the keys you `ssh-add`ed there should work nonetheless
 */
async function listAgentCandidates(config: FileSystemConfig): Promise<AgentCandidate[]> {
  const candidates: AgentCandidate[] = [];
  const add = (agentPath: string | undefined, source: string) => {
    if (agentPath && !candidates.some(c => c.path === agentPath)) candidates.push({ path: agentPath, source });
  };
  add(typeof config.agent === 'string' ? config.agent : undefined, 'IdentityAgent / SSH_AUTH_SOCK');
  add(process.env.SSH_AUTH_SOCK, 'SSH_AUTH_SOCK');
  if (process.platform === 'win32') {
    add(WINDOWS_OPENSSH_AGENT, 'OpenSSH Authentication Agent service');
    add('pageant', 'Pageant');
    return candidates;
  }
  if (process.platform === 'darwin') add(await run('launchctl', ['getenv', 'SSH_AUTH_SOCK']), 'launchd');
  let uid = -1;
  try { uid = userInfo().uid; } catch { /* Keep -1 */ }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || (process.platform === 'linux' && uid >= 0 ? `/run/user/${uid}` : undefined);
  if (runtimeDir) {
    for (const name of ['keyring/ssh', 'gcr/ssh', 'ssh-agent.socket', 'openssh_agent', 'gnupg/S.gpg-agent.ssh']) {
      add(path.join(runtimeDir, name), 'desktop session');
    }
  }
  const manual: string[] = [];
  // OpenSSH 10.1 and later
  manual.push(...await findSockets(path.join(homedir(), '.ssh', 'agent'), /agent/, uid));
  // Older versions: $TMPDIR/ssh-XXXXXXXXXX/agent.<pid>
  for (const directory of await findAgentDirectories(tmpdir())) {
    manual.push(...await findSockets(directory, /^agent\.\d+$/, uid));
  }
  for (const socket of manual.slice(0, 16)) add(socket, 'manually started ssh-agent');
  return candidates;
}

async function findAgentDirectories(tmp: string): Promise<string[]> {
  try {
    return (await fsPromises.readdir(tmp)).filter(name => /^ssh-/.test(name)).map(name => path.join(tmp, name));
  } catch {
    return [];
  }
}

/** Asks the agent at the given path for its keys, the equivalent of `ssh-add -L`. Rejects if there is no (working) agent */
async function listAgentKeys(agentPath: string): Promise<{ agent: BaseAgent; keys: Buffer[] }> {
  if (process.platform !== 'win32') {
    const stat = await fsPromises.stat(agentPath);
    if (!stat.isSocket()) throw new Error('not a socket');
  }
  const agent: BaseAgent = createAgent(agentPath);
  const identities = await new Promise<unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), AGENT_TIMEOUT);
    try {
      agent.getIdentities((error: Error | undefined | null, keys?: unknown[]) => {
        clearTimeout(timer);
        if (error) return reject(error);
        resolve(keys || []);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
  const keys: Buffer[] = [];
  for (const identity of identities) {
    const parsed = toParsedKey(identity);
    if (parsed) keys.push(parsed.getPublicSSH());
  }
  return { agent, keys };
}

function toParsedKey(key: unknown): ParsedKey | undefined {
  const parsed = Buffer.isBuffer(key) || typeof key === 'string' ? tryParseKey(key) : key as ParsedKey;
  if (!parsed || parsed instanceof Error || typeof parsed.getPublicSSH !== 'function') return undefined;
  return parsed;
}

/**
 * Finds the SSH agent to use for the given config: the first one (see `listAgentCandidates`) that actually has
 * keys loaded. Resolves to `undefined` if no agent with keys could be found.
 */
export async function findAgent(config: FileSystemConfig, logging: Logger): Promise<FoundAgent | undefined> {
  const candidates = await listAgentCandidates(config);
  const empty: string[] = [];
  for (const candidate of candidates) {
    try {
      const { agent, keys } = await listAgentKeys(candidate.path);
      if (!keys.length) {
        empty.push(candidate.path);
        logging.debug`\tThe SSH agent at ${candidate.path} (${candidate.source}) has no (usable) keys loaded`;
        continue;
      }
      logging.info`\tUsing the SSH agent at ${candidate.path} (${candidate.source}), which has ${keys.length} key(s) loaded`;
      return { ...candidate, agent, keys };
    } catch (e) {
      logging.debug`\tNo usable SSH agent at ${candidate.path} (${candidate.source}): ${(e as Error)?.message || e}`;
    }
  }
  if (empty.length) {
    logging.info`\tFound SSH agent(s) without any keys loaded (${empty.join(', ')}). Use 'ssh-add' to load your key and connect without a passphrase prompt`;
  } else {
    const looked = candidates.map(c => c.path).join(', ') || 'nothing to look at';
    logging.info`\tFound no running SSH agent (looked at: ${looked}). If 'ssh-add -l' does list your keys in a terminal, add 'IdentityAgent <value of SSH_AUTH_SOCK in that terminal>' to your OpenSSH config file`;
  }
  return undefined;
}

/**
 * Wraps the actual SSH agent, to keep track of which keys got offered through it (no need to try
 * those again using the identity files, which might even need a passphrase), to offer the keys matching
 * the configured identity files first (like OpenSSH does, servers only allow a few attempts) and to
 * optionally limit the offered keys to just those (OpenSSH's `IdentitiesOnly`).
 */
class TrackingAgent extends BaseAgent {
  constructor(protected readonly agent: BaseAgent, protected readonly offered: Buffer[], protected readonly preferred: Buffer[],
    protected readonly only: boolean, protected readonly onUnavailable: (error: Error) => void) {
    super();
    if (typeof agent.getStream === 'function') {
      // Used for agent forwarding
      this.getStream = callback => agent.getStream!(callback);
    }
  }
  public getIdentities(callback: (err: Error | undefined, keys: Buffer[]) => void): void {
    this.agent.getIdentities((err, keys) => {
      if (err) {
        // An agent that isn't running (e.g. a stale $SSH_AUTH_SOCK) shouldn't make the whole connection fail,
        // which is what ssh2 does when passing on the error. Just like `ssh`, act as if it has no keys instead
        this.onUnavailable(err);
        return callback(undefined, []);
      }
      const first: [order: number, key: ParsedKey][] = [];
      const others: ParsedKey[] = [];
      for (const key of keys || []) {
        const parsed = toParsedKey(key);
        if (!parsed) continue;
        const blob = parsed.getPublicSSH();
        const order = this.preferred.findIndex(preferred => preferred.equals(blob));
        if (order >= 0) first.push([order, parsed]);
        else if (!this.only) others.push(parsed);
        else continue;
        this.offered.push(blob);
      }
      const result = [...first.sort((a, b) => a[0] - b[0]).map(([, key]) => key), ...others];
      callback(undefined, result as any[]);
    });
  }
  public sign(pubKey: Buffer | string | ParsedKey, data: Buffer, options: SignOptions, callback: (err: Error | undefined, signature: Buffer) => void): void {
    // The options argument is optional in ssh2, in which case the callback is passed as third argument
    return (this.agent.sign as Function).call(this.agent, pubKey, data, options, callback);
  }
}

interface LazyAuthStep {
  method: 'none' | 'publickey' | 'keyboard-interactive' | 'password';
  description: string;
  /** Returns the authentication to try, or `undefined` if this step should be skipped */
  run(): Promise<AuthHandlerObject | undefined>;
}

/**
 * Authentication the way OpenSSH does it: (after `none`) first every key the SSH agent has (the ones `ssh-add -l` lists,
 * which never need a passphrase), then the identity files (only asking for a passphrase when a key turns out to be
 * encrypted and isn't loaded in the agent), then keyboard-interactive and finally passwords.
 * Methods the server doesn't accept get skipped.
 */
export function makeLazyAuthHandler(config: FileSystemConfig, logging: Logger, context: ConnectContext): AuthHandlerFunction {
  const username = config.username!;
  const target = `${username}@${config.label || config.name}`;
  const allowed = config._sshAuth || { publickey: true, password: true, keyboard: true };
  const offeredByAgent: Buffer[] = [];
  /** Why the agent didn't end up being used (if so), to explain a passphrase prompt */
  let agentNote = 'no SSH agent with keys was found';
  const steps: LazyAuthStep[] = [{ method: 'none', description: 'none', run: async () => ({ type: 'none', username }) }];
  if (allowed.publickey) {
    const files = (config.identityFiles || []).filter(file => typeof file === 'string' && file).map(expandHome);
    if (config._sshAgentDisabled) {
      agentNote = 'the SSH agent is disabled for this host (IdentityAgent none)';
    } else {
      steps.push({
        method: 'publickey', description: 'the keys loaded in the SSH agent',
        async run() {
          const agents = context.agents ||= new Map<string, Promise<FoundAgent | undefined>>();
          const cacheKey = typeof config.agent === 'string' ? config.agent : '';
          let search = agents.get(cacheKey);
          if (!search) agents.set(cacheKey, search = findAgent(config, logging));
          const found = await search;
          if (!found) return undefined;
          const publicKeys = await Promise.all(files.map(file => readPublicKey(file)));
          const preferred = publicKeys.filter((key): key is Buffer => !!key);
          const matching = found.keys.filter(key => preferred.some(p => p.equals(key))).length;
          if (config.identitiesOnly) {
            if (!matching) {
              agentNote = `the SSH agent at ${found.path} has none of the configured identity files loaded (IdentitiesOnly is set)`;
              logging.info`\tSkipping the SSH agent: ${agentNote}`;
              return undefined;
            }
          }
          agentNote = `the SSH agent at ${found.path} doesn't have this key loaded`;
          logging.debug`\t${matching} of the ${found.keys.length} agent key(s) match the configured identity files${config.identitiesOnly ? ', only offering those (IdentitiesOnly)' : ', offering those first'}`;
          const onUnavailable = (error: Error) => logging.info`\tCould not use the SSH agent at ${found.path}, skipping it: ${error.message}`;
          return { type: 'agent', username, agent: new TrackingAgent(found.agent, offeredByAgent, preferred, !!config.identitiesOnly, onUnavailable) };
        },
      });
    }
    if (config.privateKey) {
      const key = config.privateKey;
      const passphrase = typeof config.passphrase === 'string' ? config.passphrase : undefined;
      steps.push({
        method: 'publickey', description: `key ${config.privateKeyPath || '(privateKey field)'}`,
        run: async () => ({ type: 'publickey', username, key, passphrase }),
      });
    }
    for (const file of files) {
      steps.push({
        method: 'publickey', description: `key ${file}`,
        async run() {
          let data: Buffer;
          try {
            data = await fsPromises.readFile(file);
          } catch (e) {
            logging.debug`\tSkipping identity file ${file}: ${e.message || e}`;
            return undefined;
          }
          const publicKey = await readPublicKey(file, data);
          if (publicKey && offeredByAgent.some(offered => offered.equals(publicKey))) {
            logging.debug`\tSkipping identity file ${file}: already tried through the agent`;
            return undefined;
          }
          let key = context.keys.get(file) || tryParseKey(data);
          for (let attempt = 0; key instanceof Error; attempt++) {
            if (attempt >= 3 || (!attempt && !/no passphrase given/i.test(key.message))) {
              logging.warning(`Skipping identity file ${file}: ${key.message}`);
              return undefined;
            }
            if (!attempt) logging.info`\tThe key ${file} is protected by a passphrase and ${agentNote}, prompting for its passphrase. Run 'ssh-add ${file}' to connect without this prompt`;
            const passphrase = await vscode.window.showInputBox({
              password: true,
              ignoreFocusOut: true,
              placeHolder: 'Passphrase (leave empty to skip this key)',
              prompt: `${attempt ? 'Bad passphrase, try again. ' : ''}Passphrase for key ${file} to connect to ${target} (not asked for keys loaded with ssh-add)`,
            });
            if (!passphrase) {
              logging.debug`\tSkipping identity file ${file}: no passphrase given`;
              return undefined;
            }
            key = tryParseKey(data, passphrase);
          }
          context.keys.set(file, key);
          return { type: 'publickey', username, key };
        },
      });
    }
  }
  if (allowed.keyboard) {
    steps.push({
      method: 'keyboard-interactive', description: 'keyboard-interactive',
      run: async () => ({ type: 'keyboard-interactive', username, prompt: promptKeyboardInteractive(logging) }),
    });
  }
  if (allowed.password) {
    let cancelled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      steps.push({
        method: 'password', description: 'password',
        async run() {
          if (cancelled) return undefined;
          let password = !attempt && typeof config.password === 'string' ? config.password : undefined;
          password ||= await vscode.window.showInputBox({
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'Password',
            prompt: `${attempt ? 'Permission denied, try again. ' : ''}Password for ${target}`,
          });
          if (!password) {
            cancelled = true;
            return undefined;
          }
          return { type: 'password', username, password };
        },
      });
    }
  }
  return (methodsLeft: string[] | null, partialSuccess: boolean, callback: (method: AuthHandlerObject | false) => void): void => {
    (async () => {
      while (steps.length) {
        const step = steps.shift()!;
        if (methodsLeft && step.method !== 'none' && !methodsLeft.includes(step.method)) {
          logging.debug`\tSkipping authentication using ${step.description}: server only accepts ${methodsLeft}`;
          continue;
        }
        try {
          const auth = await step.run();
          if (!auth) continue;
          logging.debug`\tTrying authentication using ${step.description}`;
          return callback(auth);
        } catch (e) {
          logging.warning(`Could not authenticate using ${step.description}: ${e.message || e}`);
        }
      }
      logging.debug`\tNo authentication methods left to try`;
      callback(false);
    })().catch((e) => {
      logging.error(e);
      callback(false);
    });
  };
}
