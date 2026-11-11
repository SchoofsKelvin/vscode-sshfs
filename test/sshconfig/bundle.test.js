// Smoke test of the *packaged* extension (the webpack bundle from the .vsix), driven through
// the same entry points VS Code uses: activate(), the tree view, commands and the terminal.
// Usage: node bundle.test.js <repo (for ssh2)> <extracted vsix>/extension
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

const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfs-bundle-'));
const dotssh = path.join(realHome, '.ssh');
fs.mkdirSync(dotssh, { recursive: true });
process.env.HOME = realHome;
process.env.USERPROFILE = realHome;
delete process.env.SSH_AUTH_SOCK;
// Keep the tests independent of SSH agents that happen to be running on this machine (see src/sshAuth.ts)
process.env.TMPDIR = process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(realHome, 'tmp-'));

// Capture what the extension registers
const registered = { commands: {}, trees: {}, terminals: [], fsProvider: undefined };
vscode.commands.registerCommand = (name, cb) => { registered.commands[name] = cb; return { dispose() { } }; };
vscode.window.createTreeView = (id, options) => { registered.trees[id] = options.treeDataProvider; return { dispose() { } }; };
vscode.window.createTerminal = options => { registered.terminals.push(options); return { show() { }, name: options.name, creationOptions: options }; };
vscode.workspace.registerFileSystemProvider = (scheme, provider) => { registered.fsProvider = provider; return { dispose() { } }; };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const { Server, utils } = repoRequire('ssh2');
const { parseKey } = repoRequire('ssh2/lib/protocol/keyParser');
const SFTP_STATUS = utils.sftp.STATUS_CODE;

function makeKey(name) {
  const keys = utils.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dotssh, name), keys.private, { mode: 0o600 });
  return parseKey(keys.public);
}

/** A SSH server that really runs the requested commands (locally, using sh), forwards connections and serves a tiny read-only SFTP */
function startServer(name, user, key) {
  const log = { forwards: [], execs: [] };
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, client => {
    client.on('authentication', ctx => {
      if (ctx.username === user && ctx.method === 'publickey' && ctx.key.data.equals(key.getPublicSSH())
        && (!ctx.signature || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
      ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', accept => accept && accept());
        session.on('exec', (accept, reject, info) => {
          log.execs.push(info.command);
          const stream = accept();
          const child = spawn('/bin/sh', ['-c', info.command], { env: { ...process.env, SHELL: '/bin/sh', SERVER_NAME: name } });
          child.stdout.on('data', d => stream.write(d));
          child.stderr.on('data', d => stream.stderr.write(d));
          stream.on('data', d => child.stdin.write(d));
          child.on('close', code => { stream.exit(code || 0); stream.end(); });
        });
        session.on('sftp', accept => {
          const sftp = accept();
          sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p === '.' ? realHome : p, longname: p, attrs: {} }]));
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
        log.forwards.push(`${info.destIP}:${info.destPort}`);
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

(async () => {
  const jump = await startServer('jump', 'jumper', makeKey('id_jump'));
  const app = await startServer('app', 'deploy', makeKey('id_app'));
  fs.writeFileSync(path.join(dotssh, 'config'), `
Host jump
  HostName 127.0.0.1
  Port ${jump.port}
  User jumper
  IdentityFile ~/.ssh/id_jump

Host app
  HostName 127.0.0.1
  Port ${app.port}
  User deploy
  IdentityFile ~/.ssh/id_app
  ProxyJump jump
  RemoteCommand echo "remote command on $SERVER_NAME for %n as %r in $(pwd)"

Host app-cmd
  HostName 127.0.0.1
  Port ${app.port}
  User deploy
  IdentityFile ~/.ssh/id_app
  ProxyCommand nc %h %p

Host *
  ServerAliveInterval 30
`);

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

  // Every command from the manifest got registered
  for (const { command } of packageJSON.contributes.commands) assert.ok(registered.commands[command], `command ${command} is not registered`);

  // 1. The "Configurations" tree view lists the hosts from ~/.ssh/config
  const tree = registered.trees['sshfs-configs'];
  await new Promise(r => setTimeout(r, 500)); // Config loading is async
  const children = await tree.getChildren();
  const items = children.map(c => tree.getTreeItem(c));
  assert.deepStrictEqual(children.map(c => c.name), ['app', 'app-cmd', 'jump']);
  assert.strictEqual(items[0].description, `deploy@127.0.0.1:${app.port} via jump`);
  assert.strictEqual(items[1].description, `deploy@127.0.0.1:${app.port} via ProxyCommand`);
  assert.strictEqual(items[0].contextValue, 'config');
  console.log('  ok   tree view lists', children.map(c => c.name).join(', '));

  // 2. "Open remote SSH terminal" on the host that needs ProxyJump and has a RemoteCommand
  await registered.commands['sshfs.terminal'](children[0]);
  assert.strictEqual(registered.terminals.length, 1, `no terminal created: ${JSON.stringify(state.messages)}`);
  const pty = registered.terminals[0].pty;
  let output = '';
  pty.onDidWrite(d => output += d);
  await new Promise(resolve => { pty.onDidClose(resolve); pty.open({ columns: 80, rows: 24 }); });
  assert.match(output, new RegExp(`remote command on app for app as deploy in ${realHome}`));
  assert.deepStrictEqual(jump.log.forwards, [`127.0.0.1:${app.port}`]);
  console.log('  ok   terminal through ProxyJump ran the RemoteCommand:', output.split('\r\n').pop().trim());

  // 3. The connection shows up in the "Connections" tree view
  const connections = await registered.trees['sshfs-connections'].getChildren();
  assert.strictEqual(connections.length, 1);
  assert.strictEqual(connections[0].actualConfig.name, 'app');
  assert.strictEqual(connections[0].home, realHome);
  console.log('  ok   connection listed with detected home', connections[0].home);

  // 4. The file system provider (what backs ssh:// workspace folders) works through a ProxyCommand
  const stat = await registered.fsProvider.stat(vscode.Uri.parse(`ssh://app-cmd${dotssh}/config`));
  assert.strictEqual(stat.type, vscode.FileType.File);
  assert.strictEqual(stat.size, fs.statSync(path.join(dotssh, 'config')).size);
  console.log('  ok   ssh://app-cmd/ file access through ProxyCommand, size', stat.size);

  // 5. Nothing was prompted, nothing was written to the settings
  assert.deepStrictEqual(state.prompts, []);
  assert.deepStrictEqual(state.settings, {});
  console.log('  ok   no prompts, no settings written');

  // 6. Disconnecting works
  await registered.commands['sshfs.disconnectAll']();
  assert.strictEqual((await registered.trees['sshfs-connections'].getChildren()).length, 0);
  console.log('  ok   disconnect all');

  fs.rmSync(realHome, { recursive: true, force: true });
  process.exit(0);
})().catch(e => {
  console.error(e);
  console.error(state.log.filter(l => /ERROR|WARN/.test(l)).slice(-10).join('\n'));
  process.exit(1);
});
