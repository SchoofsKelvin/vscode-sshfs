// Tests that keys loaded in a SSH agent (what `ssh-add -l` lists) are used without ever prompting for a passphrase.
// Runs the *packaged* extension (the bundle from the .vsix) through the entry points VS Code uses, against
// in-process SSH servers and in-process SSH agents.
// Usage: node agent.test.js <repo (for ssh2)> <extracted vsix>/extension
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');

const [REPO, EXT] = process.argv.slice(2);
const repoRequire = Module.createRequire(path.join(REPO, 'package.json'));
const vscode = require('./vscode-mock');
const state = vscode.__state;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfs-agent-'));
const dotssh = path.join(home, '.ssh');
const tmp = path.join(home, 'tmp');
const runtime = path.join(home, 'run');
for (const dir of [dotssh, path.join(tmp, 'ssh-XXXXtest01'), runtime]) fs.mkdirSync(dir, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TMPDIR = tmp;
process.env.XDG_RUNTIME_DIR = runtime;
// What VS Code got started with: an agent that isn't running (anymore). The agent that actually holds the keys
// got started "by hand in a terminal" and is thus unknown to VS Code
process.env.SSH_AUTH_SOCK = path.join(home, 'stale-agent.sock');

const registered = { commands: {}, fsProvider: undefined };
vscode.commands.registerCommand = (name, cb) => { registered.commands[name] = cb; return { dispose() { } }; };
vscode.workspace.registerFileSystemProvider = (scheme, provider) => { registered.fsProvider = provider; return { dispose() { } }; };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const { Server, AgentProtocol, utils } = repoRequire('ssh2');
const { parseKey } = repoRequire('ssh2/lib/protocol/keyParser');
const SFTP_STATUS = utils.sftp.STATUS_CODE;

const PASSPHRASE = 'correct horse';
/** Creates a passphrase-protected key. On purpose without a .pub file next to it, the worst case for recognizing it in the agent */
function makeKey(name) {
  const options = { passphrase: PASSPHRASE, cipher: 'aes256-ctr' };
  const keys = utils.generateKeyPairSync('ed25519', options);
  const file = path.join(dotssh, name);
  fs.writeFileSync(file, keys.private, { mode: 0o600 });
  return { name, file, parsed: parseKey(keys.private, PASSPHRASE), public: parseKey(keys.public) };
}

/** A tiny ssh-agent holding the given keys */
function startAgent(sockPath, keys) {
  const log = { identities: 0, signs: 0 };
  const server = net.createServer(sock => {
    const proto = new AgentProtocol(false);
    sock.pipe(proto).pipe(sock);
    sock.on('error', () => { });
    proto.on('identities', req => { log.identities++; proto.getIdentitiesReply(req, keys.map(k => k.public)); });
    proto.on('sign', (req, pubKey, data, options) => {
      log.signs++;
      const key = keys.find(k => k.public.getPublicSSH().equals(pubKey.getPublicSSH()));
      if (!key) return proto.failureReply(req);
      proto.signReply(req, key.parsed.sign(data, options && options.hash));
    });
  });
  return new Promise(resolve => server.listen(sockPath, () => resolve({ log, path: sockPath })));
}

/** A SSH server with a tiny read-only SFTP, accepting one specific key per user and logging which keys got offered */
function startServer(users, allKeys) {
  const log = { offered: [] };
  const nameOf = blob => (allKeys.find(k => k.public.getPublicSSH().equals(blob)) || { name: 'unknown' }).name;
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, client => {
    client.on('authentication', ctx => {
      const key = users[ctx.username];
      if (ctx.method !== 'publickey' || !key) return ctx.reject(['publickey']);
      if (!ctx.signature) log.offered.push(`${ctx.username}:${nameOf(ctx.key.data)}`);
      if (ctx.key.data.equals(key.public.getPublicSSH())
        && (!ctx.signature || key.public.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
      ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('exec', (accept, reject, info) => {
          const stream = accept();
          const child = spawn('/bin/sh', ['-c', info.command], { env: { ...process.env, SHELL: '/bin/sh' } });
          child.stdout.on('data', d => stream.write(d));
          child.stderr.on('data', d => stream.stderr.write(d));
          child.on('close', code => { stream.exit(code || 0); stream.end(); });
        });
        session.on('sftp', accept => {
          const sftp = accept();
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? home : p, longname: p, attrs: {} }]));
          const stat = (id, p) => {
            try {
              const s = fs.statSync(p);
              sftp.attrs(id, { mode: s.mode, uid: s.uid, gid: s.gid, size: s.size, atime: s.atimeMs / 1000 | 0, mtime: s.mtimeMs / 1000 | 0 });
            } catch { sftp.status(id, SFTP_STATUS.NO_SUCH_FILE); }
          };
          sftp.on('STAT', stat).on('LSTAT', stat);
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP, () => {
          const stream = accept();
          stream.pipe(sock).pipe(stream);
          stream.on('close', () => sock.destroy());
          sock.on('close', () => stream.end());
        });
        sock.once('error', () => { });
      });
    });
    client.on('error', () => { });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ log, port: server.address().port })));
}

// A failed connection also rejects promises nobody is waiting for (anymore)
process.on('unhandledRejection', () => { });

let failed = 0;
async function test(name, fn) {
  state.prompts.length = 0;
  state.inputAnswers.length = 0;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${`${e.message || e}`.split('\n').join('\n       ')}`);
  }
  await registered.commands['sshfs.disconnectAll']();
}

(async () => {
  const kOther = makeKey('id_other');
  const kLoaded = makeKey('id_loaded');
  const kOnly = makeKey('id_only');
  const kSecret = makeKey('id_secret');
  const kExplicit = makeKey('id_explicit');
  const all = [kOther, kLoaded, kOnly, kSecret, kExplicit];
  const server = await startServer({
    loaded: kLoaded, only: kOnly, anykey: kOther, secret: kSecret, noagent: kLoaded, explicit: kExplicit, jumper: kLoaded, behind: kOnly,
  }, all);
  // An agent of the desktop session that is running but has no keys, the "manually started" agent that
  // has the keys (ssh-add), and one that is only reachable through an explicit IdentityAgent
  const emptyAgent = await startAgent(path.join(runtime, 'ssh-agent.socket'), []);
  const agent = await startAgent(path.join(tmp, 'ssh-XXXXtest01', 'agent.4242'), [kOther, kLoaded, kOnly]);
  const explicitAgent = await startAgent(path.join(home, 'explicit.sock'), [kExplicit]);

  const host = (name, extra) => `Host ${name}\n  HostName 127.0.0.1\n  Port ${server.port}\n  User ${name}\n${extra.map(l => `  ${l}\n`).join('')}\n`;
  fs.writeFileSync(path.join(dotssh, 'config'), [
    host('loaded', ['IdentityFile ~/.ssh/id_loaded']),
    host('only', ['IdentityFile ~/.ssh/id_only', 'IdentitiesOnly yes']),
    host('anykey', []),
    host('secret', ['IdentityFile ~/.ssh/id_secret']),
    host('noagent', ['IdentityFile ~/.ssh/id_loaded', 'IdentityAgent none']),
    host('explicit', ['IdentityFile ~/.ssh/id_explicit', `IdentityAgent ${explicitAgent.path}`]),
    host('jumper', ['IdentityFile ~/.ssh/id_loaded']),
    host('behind', ['IdentityFile ~/.ssh/id_only', 'ProxyJump jumper']),
  ].join(''));

  const extension = require(path.join(EXT, 'dist', 'extension.js'));
  const packageJSON = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  const globalState = new Map();
  extension.activate({
    extension: { packageJSON },
    extensionMode: 1,
    extensionUri: vscode.Uri.file(EXT),
    extensionPath: EXT,
    subscriptions: [],
    globalState: { get: (k, d) => globalState.has(k) ? globalState.get(k) : d, update: async (k, v) => { globalState.set(k, v); } },
  });
  await new Promise(r => setTimeout(r, 500)); // Config loading is async
  console.log(`Testing ${packageJSON.name} ${packageJSON.version}`);

  /** Connects to the host (like opening a ssh:// workspace folder does) and returns which keys the server saw for it */
  const connect = async (name) => {
    server.log.offered.length = 0;
    const stat = await registered.fsProvider.stat(vscode.Uri.parse(`ssh://${name}${dotssh}/config`));
    assert.strictEqual(stat.type, vscode.FileType.File);
    return server.log.offered.filter(o => o.startsWith(`${name}:`)).map(o => o.substring(name.length + 1));
  };

  await test('key loaded in the agent: no passphrase prompt (encrypted key file without .pub, agent not in $SSH_AUTH_SOCK)', async () => {
    const offered = await connect('loaded');
    assert.deepStrictEqual(state.prompts, []);
    // The key of the IdentityFile is offered first, even though the agent lists another key before it
    assert.deepStrictEqual(offered, ['id_loaded']);
  });

  await test('IdentitiesOnly: only the configured key is taken from the agent, no passphrase prompt', async () => {
    const offered = await connect('only');
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(offered, ['id_only']);
  });

  await test('no IdentityFile at all: every key of the agent is offered', async () => {
    const offered = await connect('anykey');
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(offered, ['id_other']);
  });

  await test('ProxyJump: both the jump host and the target use the agent, no prompts', async () => {
    await connect('behind');
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(server.log.offered, ['jumper:id_loaded', 'behind:id_only']);
  });

  await test('explicit IdentityAgent is used when it has keys', async () => {
    const before = agent.log.identities;
    const offered = await connect('explicit');
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(offered, ['id_explicit']);
    assert.strictEqual(agent.log.identities, before, 'the other agent should not have been asked');
    assert.ok(explicitAgent.log.signs >= 1);
  });

  await test('key that is not loaded in the agent: passphrase prompted once (never stored), as last resort', async () => {
    state.inputAnswers.push(PASSPHRASE);
    const offered = await connect('secret');
    assert.strictEqual(state.prompts.length, 1);
    assert.match(state.prompts[0], /Passphrase for key .*id_secret/);
    // The agent keys were tried first
    assert.deepStrictEqual(offered, ['id_other', 'id_loaded', 'id_only', 'id_secret']);
  });

  await test('IdentityAgent none: the agent is not used at all', async () => {
    const before = agent.log.identities + emptyAgent.log.identities;
    state.inputAnswers.push(PASSPHRASE);
    const offered = await connect('noagent');
    assert.strictEqual(state.prompts.length, 1);
    assert.deepStrictEqual(offered, ['id_loaded']);
    assert.strictEqual(agent.log.identities + emptyAgent.log.identities, before);
  });

  await test('nothing was written to the settings', async () => {
    assert.deepStrictEqual(state.settings, {});
  });

  fs.rmSync(home, { recursive: true, force: true });
  if (failed) console.error(state.log.filter(l => /agent|ERROR|WARN/i.test(l)).slice(-25).join('\n'));
  console.log(failed ? `${failed} test(s) failed` : 'All tests passed');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(e);
  console.error(state.log.filter(l => /ERROR|WARN/.test(l)).slice(-10).join('\n'));
  process.exit(1);
});
