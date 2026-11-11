// End-to-end tests: the extension's real config + connection code against in-process SSH servers.
// Usage: node integration.test.js <repo> <compiled-out-dir>
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');

const [REPO, OUT] = process.argv.slice(2);
const repoRequire = Module.createRequire(path.join(REPO, 'package.json'));
const vscode = require('./vscode-mock');
const state = vscode.__state;

// Temporary home directory, has to be set up before the extension code gets loaded
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfs-it-'));
const dotssh = path.join(home, '.ssh');
fs.mkdirSync(dotssh, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.SSH_AUTH_SOCK;
// Keep the tests independent of SSH agents that happen to be running on this machine (see src/sshAuth.ts)
process.env.TMPDIR = process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(home, 'tmp-'));

// Redirect `vscode` to the mock and the `common` workspace package to its CommonJS build
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request.startsWith('common/')) request = path.join(OUT, 'common', `${request.substring(7)}.js`);
  return originalLoad.call(this, request, parent, isMain);
};

const { Server, AgentProtocol, utils } = repoRequire('ssh2');
const { parseKey } = repoRequire('ssh2/lib/protocol/keyParser');

function makeKey(name, options) {
  const keys = utils.generateKeyPairSync('ed25519', options);
  const file = path.join(dotssh, name);
  fs.writeFileSync(file, keys.private, { mode: 0o600 });
  fs.writeFileSync(`${file}.pub`, keys.public);
  return { file, parsed: parseKey(keys.private, options && options.passphrase), public: parseKey(keys.public) };
}

const hostKey = utils.generateKeyPairSync('ed25519').private;

/** Starts a SSH server that accepts the given user with the given key and/or password */
function startServer(name, { user, key, password, keyboard }) {
  const log = { name, auth: [], forwards: [], execs: [], connections: 0 };
  const server = new Server({ hostKeys: [hostKey] }, client => {
    log.connections++;
    const methods = [];
    if (key) methods.push('publickey');
    if (keyboard) methods.push('keyboard-interactive');
    if (password) methods.push('password');
    client.on('authentication', ctx => {
      log.auth.push(`${ctx.method}:${ctx.username}${ctx.method === 'publickey' && !ctx.signature ? ':check' : ''}`);
      if (ctx.username !== user) return ctx.reject(methods);
      if (ctx.method === 'publickey' && key && ctx.key.data.equals(key.public.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (key.public.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      } else if (ctx.method === 'password' && password && ctx.password === password) {
        return ctx.accept();
      } else if (ctx.method === 'keyboard-interactive' && keyboard) {
        return ctx.prompt([{ prompt: 'Verification code: ', echo: false }], answers => answers[0] === keyboard ? ctx.accept() : ctx.reject(methods));
      }
      ctx.reject(methods);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', accept => accept && accept());
        session.on('exec', (accept, reject, info) => {
          log.execs.push(info.command);
          const stream = accept();
          // Like a real command, don't finish within the very same network packet as the channel confirmation
          setTimeout(() => {
            stream.write(`${name} ran: ${info.command}`);
            stream.exit(0);
            stream.end();
          }, 20);
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        log.forwards.push(`${info.destIP}:${info.destPort}`);
        const sock = net.connect(info.destPort, info.destIP);
        sock.once('error', () => reject());
        sock.once('connect', () => {
          const stream = accept();
          stream.pipe(sock).pipe(stream);
          stream.on('close', () => sock.destroy());
          sock.on('close', () => stream.end());
        });
      });
    });
    client.on('error', () => { });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ log, server, port: server.address().port })));
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
  return new Promise(resolve => server.listen(sockPath, () => resolve({ log, server })));
}

function exec(client, command) {
  return new Promise((resolve, reject) => client.exec(command, (err, stream) => {
    if (err) return reject(err);
    let out = '';
    stream.on('data', d => out += d).on('close', () => resolve(out));
  }));
}

const results = [];
async function test(name, fn) {
  state.prompts.length = 0;
  state.inputAnswers.length = 0;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}
const resetLogs = (...servers) => servers.forEach(s => { s.log.auth.length = 0; s.log.forwards.length = 0; s.log.execs.length = 0; s.log.connections = 0; });

(async () => {
  const kBastion = makeKey('id_bastion');
  const kTarget = makeKey('id_target', { passphrase: 'sesame', cipher: 'aes256-ctr' });
  const kAgent = makeKey('id_agentkey', { passphrase: 'only-the-agent-knows', cipher: 'aes256-ctr' });
  const kOther = makeKey('id_other');
  const kDefault = makeKey('id_ed25519');

  const bastion = await startServer('bastion', { user: 'jumper', key: kBastion });
  const middle = await startServer('middle', { user: 'mid', password: 'midpass' });
  const target = await startServer('target', { user: 'app', key: kTarget });
  const agentHost = await startServer('agenthost', { user: 'ag', key: kAgent, password: 'unused' });
  const otp = await startServer('otp', { user: 'otpuser', keyboard: '123456' });
  const plain = await startServer('plain', { user: os.userInfo().username, key: kDefault });
  const agentSock = path.join(home, 'agent.sock');
  const agent = await startAgent(agentSock, [kOther, kAgent]);

  fs.writeFileSync(path.join(dotssh, 'config'), `
Host bastion
  HostName 127.0.0.1
  Port ${bastion.port}
  User jumper
  IdentityFile ~/.ssh/id_bastion

Host middle
  HostName 127.0.0.1
  Port ${middle.port}
  User mid
  IdentityFile none

Host target
  HostName 127.0.0.1
  Port ${target.port}
  User app
  IdentityFile ~/.ssh/id_target
  ProxyJump bastion,middle
  RemoteCommand tmux new -A -s %n-%r

Host onejump
  HostName 127.0.0.1
  Port ${target.port}
  User app
  IdentityFile ~/.ssh/id_target
  ProxyJump jumper@Bastion:${bastion.port}

Host viacmd
  HostName 127.0.0.1
  Port ${target.port}
  User app
  IdentityFile ~/.ssh/id_target
  ProxyCommand nc %h %p

Host badcmd
  HostName 127.0.0.1
  User app
  ProxyCommand sh -c 'echo proxy went wrong >&2; exit 3'

Host agenthost
  HostName 127.0.0.1
  Port ${agentHost.port}
  User ag
  IdentityAgent ${agentSock}
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_agentkey

Host otp
  HostName 127.0.0.1
  Port ${otp.port}
  User otpuser
  IdentityFile none

Host Plain
  HostName 127.0.0.1
  Port ${plain.port}

Host samekey
  HostName 127.0.0.1
  Port ${target.port}
  User app
  IdentityFile ~/.ssh/id_target
  ProxyJump samekey-jump

Host samekey-jump
  HostName 127.0.0.1
  Port ${target.port}
  User app
  IdentityFile ~/.ssh/id_target

Host deadagent
  HostName 127.0.0.1
  Port ${bastion.port}
  User jumper
  IdentityAgent ~/does-not-exist.sock
  IdentityFile ~/.ssh/id_bastion

Host loop
  HostName 127.0.0.1
  ProxyJump loop

Host *.wild
  HostName 127.0.0.1
  Port ${target.port}
  User app
  IdentityFile ~/.ssh/id_target
  ProxyJump bastion

Host github.com
  User git
`);

  // A classic SSH FS config in the user settings: overrides/merges with the OpenSSH config host of the same name
  state.settings['sshfs.configs'] = {
    globalValue: [
      { name: 'onejump', merge: true, root: '/srv/data', label: 'One Jump' },
      { name: 'legacy', host: '127.0.0.1', port: middle.port, username: 'mid', password: 'midpass' },
      { name: 'legacyjump', host: '127.0.0.1', port: target.port, username: 'app', proxyJump: 'bastion', identityFiles: ['~/.ssh/id_target'] },
    ],
    // Pretend a workspace (e.g. a cloned repository) tries to make us run a command
    workspaceValue: [{ name: 'evil', host: '127.0.0.1', username: 'x', password: 'x', proxyCommand: `touch ${path.join(home, 'PWNED')}` }],
  };
  state.settings['sshfs.sshConfig.exclude'] = { globalValue: ['github.*'] };

  const config = require(path.join(OUT, 'config.js'));
  const connect = require(path.join(OUT, 'connect.js'));
  const configs = await config.loadConfigs();
  const byName = name => config.getConfig(name);

  await test('lists the hosts from ~/.ssh/config, next to classic configs', async () => {
    const names = configs.map(c => c.name).sort();
    if (names.length !== 16) console.log(names, configs.filter(c => !c._location || !`${c._location}`.includes(home)).map(c => [c.name, c._location]));
    assert.deepStrictEqual(names, ['agenthost', 'badcmd', 'bastion', 'deadagent', 'evil', 'legacy', 'legacyjump', 'loop', 'middle', 'onejump', 'otp', 'plain', 'samekey', 'samekey-jump', 'target', 'viacmd']);
    const t = byName('target');
    assert.strictEqual(t.host, '127.0.0.1');
    assert.strictEqual(t.username, 'app');
    assert.strictEqual(t.root, '~');
    assert.strictEqual(t._location, `sshconfig:${path.join(dotssh, 'config')}`);
    assert.strictEqual(t._sshConfigSource.line, 14);
    assert.strictEqual(byName('plain')._sshConfigHost, 'Plain');
  });

  await test('nothing gets written to the settings', async () => {
    assert.deepStrictEqual(Object.keys(state.settings).sort(), ['sshfs.configs', 'sshfs.sshConfig.exclude']);
    assert.strictEqual(state.settings['sshfs.configs'].globalValue.length, 3);
  });

  await test('hosts from the OpenSSH config are read-only', async () => {
    await assert.rejects(() => config.updateConfig({ ...byName('target'), root: '/x' }), /read-only/);
    await assert.rejects(() => config.deleteConfig(byName('target')), /read-only/);
  });

  await test('classic config with merge:true inherits from the OpenSSH config host', async () => {
    const c = byName('onejump');
    assert.strictEqual(c.root, '/srv/data');
    assert.strictEqual(c.label, 'One Jump');
    assert.strictEqual(c.proxyJump, `jumper@Bastion:${bastion.port}`);
    assert.strictEqual(c._location, 1);
  });

  await test('key authentication with an unencrypted identity file, no prompts', async () => {
    resetLogs(bastion);
    const client = await connect.createSSH(byName('bastion'));
    assert.strictEqual(await exec(client, 'whoami'), 'bastion ran: whoami');
    client.end();
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(bastion.log.auth, ['none:jumper', 'publickey:jumper:check', 'publickey:jumper']);
  });

  await test('default identity file and local username when the config only has a HostName', async () => {
    const client = await connect.createSSH(byName('plain'));
    assert.strictEqual(await exec(client, 'x'), 'plain ran: x');
    client.end();
    assert.deepStrictEqual(state.prompts, []);
  });

  await test('password gets prompted (not stored), wrong password gets a retry', async () => {
    resetLogs(middle);
    state.inputAnswers.push('wrong', 'midpass');
    const client = await connect.createSSH(byName('middle'));
    client.end();
    assert.strictEqual(state.prompts.length, 2);
    assert.match(state.prompts[0], /^Password for mid@middle/);
    assert.match(state.prompts[1], /try again/);
    assert.deepStrictEqual(middle.log.auth, ['none:mid', 'password:mid', 'password:mid']);
    assert.strictEqual(JSON.stringify(state.settings).includes('midpass') && !JSON.stringify(state.settings['sshfs.configs'].globalValue[1]).includes('midpass'), false);
  });

  await test('cancelling the password prompt fails the connection without further prompts', async () => {
    state.inputAnswers.push(undefined);
    await assert.rejects(() => connect.createSSH(byName('middle')), /All configured authentication methods failed/);
    assert.strictEqual(state.prompts.length, 1);
  });

  await test('keyboard-interactive (e.g. OTP) prompts', async () => {
    state.inputAnswers.push('123456');
    const client = await connect.createSSH(byName('otp'));
    client.end();
    assert.deepStrictEqual(state.prompts, ['Verification code']);
  });

  await test('ProxyJump chain (bastion,middle) with encrypted key: prompts for password and passphrase', async () => {
    resetLogs(bastion, middle, target);
    state.inputAnswers.push(
      o => { assert.match(o.prompt, /Password for mid@middle/); return 'midpass'; },
      o => { assert.match(o.prompt, /Passphrase for key .*id_target/); return 'bad'; },
      o => { assert.match(o.prompt, /Bad passphrase/); return 'sesame'; },
    );
    const client = await connect.createSSH(byName('target'));
    assert.strictEqual(await exec(client, 'uname'), 'target ran: uname');
    assert.strictEqual(state.prompts.length, 3);
    assert.deepStrictEqual(bastion.log.forwards, [`127.0.0.1:${middle.port}`]);
    assert.deepStrictEqual(middle.log.forwards, [`127.0.0.1:${target.port}`]);
    assert.strictEqual(target.log.connections, 1);
    client.end();
    // Closing the connection also closes the jump host connections
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(bastion.server._connections ?? 0, 0);
  });

  await test('ProxyJump with inline user@host:port', async () => {
    resetLogs(bastion, target);
    state.inputAnswers.push('sesame');
    const client = await connect.createSSH(byName('onejump'));
    assert.strictEqual(await exec(client, 'id'), 'target ran: id');
    client.end();
    assert.deepStrictEqual(bastion.log.forwards, [`127.0.0.1:${target.port}`]);
    assert.ok(bastion.log.auth.includes('publickey:jumper'));
  });

  await test('proxyJump + identityFiles also work for classic JSON configs', async () => {
    resetLogs(bastion, target);
    state.inputAnswers.push('sesame');
    const client = await connect.createSSH(byName('legacyjump'));
    assert.strictEqual(await exec(client, 'id'), 'target ran: id');
    client.end();
    assert.deepStrictEqual(bastion.log.forwards, [`127.0.0.1:${target.port}`]);
  });

  await test('classic config with a stored password still works as before', async () => {
    const client = await connect.createSSH(byName('legacy'));
    client.end();
    assert.deepStrictEqual(state.prompts, []);
  });

  await test('instant connection to a host only matched by a wildcard block uses its ProxyJump', async () => {
    resetLogs(bastion, target);
    state.inputAnswers.push('sesame');
    const c = byName('app@something.wild');
    assert.strictEqual(c.proxyJump, 'bastion');
    assert.strictEqual(c.root, undefined);
    const client = await connect.createSSH(c);
    client.end();
    assert.deepStrictEqual(bastion.log.forwards, [`127.0.0.1:${target.port}`]);
  });

  await test('instant connection user@alias keeps the port of the alias', async () => {
    const c = byName('someoneelse@bastion');
    assert.strictEqual(c.port, bastion.port);
    assert.strictEqual(c.username, 'someoneelse');
  });

  await test('ProxyCommand (nc %h %p) with token expansion', async () => {
    resetLogs(target);
    state.inputAnswers.push('sesame');
    const client = await connect.createSSH(byName('viacmd'));
    assert.strictEqual(await exec(client, 'hostname'), 'target ran: hostname');
    client.end();
    assert.strictEqual(target.log.connections, 1);
    assert.ok(state.log.some(l => l.includes(`Connecting through ProxyCommand: nc 127.0.0.1 ${target.port}`)));
  });

  await test('failing ProxyCommand reports its exit code and stderr', async () => {
    await assert.rejects(() => connect.createSSH(byName('badcmd')), e => /exited with code 3/.test(e.message) && /proxy went wrong/.test(e.message));
  });

  await test('proxyCommand from workspace settings is refused in an untrusted workspace', async () => {
    state.trusted = false;
    try {
      await assert.rejects(() => connect.createSSH(byName('evil')), /only allowed for configs from your OpenSSH config file or user settings/);
      // ...while the ones from ~/.ssh/config keep working
      state.inputAnswers.push('sesame');
      (await connect.createSSH(byName('viacmd'))).end();
    } finally {
      state.trusted = true;
    }
    assert.ok(!fs.existsSync(path.join(home, 'PWNED')));
  });

  await test('agent + IdentitiesOnly: only the configured key is offered, no passphrase prompt', async () => {
    resetLogs(agentHost);
    const client = await connect.createSSH(byName('agenthost'));
    assert.strictEqual(await exec(client, 'x'), 'agenthost ran: x');
    client.end();
    assert.deepStrictEqual(state.prompts, []);
    assert.deepStrictEqual(agentHost.log.auth, ['none:ag', 'publickey:ag:check', 'publickey:ag']);
    assert.strictEqual(agent.log.signs, 1);
  });

  await test('RemoteCommand ends up in the connection config with tokens expanded', async () => {
    const actual = await connect.calculateActualConfig(byName('target'));
    assert.strictEqual(actual.remoteCommand, 'tmux new -A -s target-app');
  });

  await test('terminals run the RemoteCommand instead of the default shell (in the default root folder)', async () => {
    resetLogs(target);
    state.inputAnswers.push('midpass', 'sesame');
    const actualConfig = await connect.calculateActualConfig(byName('target'));
    const client = await connect.createSSH(actualConfig);
    const { KNOWN_SHELL_CONFIGS } = require(path.join(OUT, 'shellConfig.js'));
    const { createTerminal } = require(path.join(OUT, 'pseudoTerminal.js'));
    const connection = { actualConfig, client, config: byName('target'), shellConfig: KNOWN_SHELL_CONFIGS.sh, environment: [], terminals: [], filesystems: [] };
    const pty = await createTerminal({ connection });
    let output = '';
    pty.onDidWrite(data => output += data);
    await new Promise(resolve => { pty.onDidClose(resolve); pty.open(undefined); });
    client.end();
    assert.deepStrictEqual(target.log.execs, ['cd ~/""; tmux new -A -s target-app']);
    assert.match(output, /target ran: cd/);
  });

  await test('jump host and target sharing an encrypted key only prompt for the passphrase once', async () => {
    resetLogs(target);
    state.inputAnswers.push('sesame');
    const client = await connect.createSSH(byName('samekey'));
    client.end();
    assert.strictEqual(state.prompts.length, 1);
    assert.strictEqual(target.log.connections, 2);
    // ...but a new connection attempt asks again, nothing is remembered
    state.inputAnswers.push('sesame');
    (await connect.createSSH(byName('samekey-jump'))).end();
    assert.strictEqual(state.prompts.length, 2);
  });

  await test('an unreachable agent is skipped', async () => {
    const client = await connect.createSSH(byName('deadagent'));
    client.end();
    assert.deepStrictEqual(state.prompts, []);
  });

  await test('a host that jumps through itself fails instead of looping forever', async () => {
    await assert.rejects(() => connect.createSSH(byName('loop')), /Too many nested hops/);
  });

  await test('excluded hosts are not listed', async () => {
    assert.strictEqual(configs.find(c => c.name === 'github.com'), undefined);
  });

  await test('changes to ~/.ssh/config get picked up on reload', async () => {
    fs.appendFileSync(path.join(dotssh, 'config'), '\nHost added-later\n  HostName 10.1.2.3\n');
    const reloaded = await config.loadConfigs();
    assert.ok(reloaded.find(c => c.name === 'added-later'));
    state.settings['sshfs.sshConfig.enabled'] = { globalValue: false };
    const disabled = await config.loadConfigs();
    assert.deepStrictEqual(disabled.map(c => c.name).sort(), ['evil', 'legacy', 'legacyjump', 'onejump']);
  });

  fs.rmSync(home, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
