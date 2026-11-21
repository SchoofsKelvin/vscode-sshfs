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
const registered = { commands: {}, trees: {}, terminals: [], profiles: {}, openTerminal: new vscode.EventEmitter(), fsProvider: undefined };
vscode.window.registerTerminalProfileProvider = (id, provider) => { registered.profiles[id] = provider; return { dispose() { } }; };
vscode.window.onDidOpenTerminal = registered.openTerminal.event;
registered.configChanged = new vscode.EventEmitter();
vscode.workspace.onDidChangeConfiguration = registered.configChanged.event;
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

  // Every terminal profile from the manifest got registered, and activates the extension
  for (const { id } of packageJSON.contributes.terminal.profiles) {
    assert.ok(registered.profiles[id], `terminal profile ${id} is not registered`);
    assert.ok(packageJSON.activationEvents.includes(`onTerminalProfile:${id}`), `no activation event for terminal profile ${id}`);
  }
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

  // 3b. Terminal profiles, in the dropdown of the "+" button of the terminal panel
  const profiles = registered.profiles;
  const messagesBefore = state.messages.length;
  const DEFAULT = 'New Terminal in connected SSH host';
  assert.strictEqual(packageJSON.contributes.terminal.profiles.find(p => p.id === 'sshfs.terminalProfile.connected').title, DEFAULT);
  // The "connected host" profile is made the default one, i.e. what the "+" button opens
  assert.strictEqual((state.settings['terminal.integrated.defaultProfile.linux'] || {}).globalValue, DEFAULT);
  const openedPty = async (profile, host) => {
    assert.ok(profile instanceof vscode.TerminalProfile, `no terminal profile: ${JSON.stringify(state.messages)}`);
    const { pty } = profile.options;
    // VS Code creates the terminal itself, the pseudo terminal gets linked to it (used by "Focus terminal")
    const terminal = { name: profile.options.name, creationOptions: profile.options, show() { } };
    registered.openTerminal.fire({ name: 'other', creationOptions: {} });
    registered.openTerminal.fire(terminal);
    assert.strictEqual(pty.terminal, terminal);
    // Open it (runs the command on the server), wait until the server got it, then close it again
    const before = host.log.execs.length;
    pty.open({ columns: 80, rows: 24 });
    for (let i = 0; i < 100 && host.log.execs.length === before; i++) await new Promise(r => setTimeout(r, 50));
    pty.close();
    return host.log.execs.slice(before).join('\n');
  };
  // Without SSH workspace folders: the active connection
  let profile = await profiles['sshfs.terminalProfile.connected'].provideTerminalProfile({});
  assert.strictEqual(profile.options.name, 'app');
  assert.strictEqual(registered.terminals.length, 1, 'the extension should not create the terminal itself');
  await openedPty(profile, app);
  // With SSH workspace folders: straight away in the folder of the active editor, like "Open remote SSH terminal" in the explorer
  vscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.parse(`ssh://jump${realHome}`), name: 'jump', index: 0 },
    { uri: vscode.Uri.parse(`ssh://app-cmd${dotssh}`), name: 'app-cmd', index: 1 },
  ];
  vscode.window.activeTextEditor = { document: { uri: vscode.Uri.parse(`ssh://app-cmd${dotssh}/config`) } };
  profile = await profiles['sshfs.terminalProfile.connected'].provideTerminalProfile({});
  assert.strictEqual(profile.options.name, 'app-cmd');
  assert.match(await openedPty(profile, app), new RegExp(`cd .*${dotssh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // Without an active editor on a SSH folder: the first SSH workspace folder
  vscode.window.activeTextEditor = undefined;
  profile = await profiles['sshfs.terminalProfile.connected'].provideTerminalProfile({});
  assert.strictEqual(profile.options.name, 'jump');
  // "Open remote SSH terminal" asks: "New Terminal in <name>" per workspace folder/connection, this computer, other hosts
  let pickedFrom;
  state.quickPickChoice = items => (pickedFrom = items).find(i => /New Terminal in app-cmd/.test(i.label));
  profile = await profiles['sshfs.terminalProfile'].provideTerminalProfile({});
  assert.deepStrictEqual(pickedFrom.map(i => i.label.replace(/^\$\([a-z-]+\) /, '')),
    ['New Terminal in jump', 'New Terminal in app-cmd', 'New Terminal in app', 'New Terminal (this computer)', 'Other host or connection...']);
  assert.strictEqual(profile.options.name, 'app-cmd');
  state.quickPickChoice = items => items.find(i => /this computer/.test(i.label));
  profile = await profiles['sshfs.terminalProfile'].provideTerminalProfile({});
  assert.ok(profile.options.shellPath && !profile.options.pty, 'expected a local shell');
  // Dismissing the picker: no profile (thus no terminal), and no "No terminal profile options provided" error
  state.quickPickChoice = undefined;
  const dismissed = await Promise.race([profiles['sshfs.terminalProfile'].provideTerminalProfile({}), new Promise(r => setTimeout(() => r('pending'), 300))]);
  assert.strictEqual(dismissed, 'pending');
  // "New Terminal (this computer)"
  profile = await profiles['sshfs.terminalProfile.local'].provideTerminalProfile({});
  assert.ok(profile.options.shellPath && !profile.options.pty, 'expected a local shell');
  vscode.workspace.workspaceFolders = undefined;
  assert.strictEqual(state.messages.length, messagesBefore, `unexpected messages: ${JSON.stringify(state.messages.slice(messagesBefore))}`);
  console.log('  ok   terminal profiles: default opens in the connected host/workspace folder, "New Terminal in <name>" picker, this computer');

  // 4. The file system provider (what backs ssh:// workspace folders) works through a ProxyCommand
  const stat = await registered.fsProvider.stat(vscode.Uri.parse(`ssh://app-cmd${dotssh}/config`));
  assert.strictEqual(stat.type, vscode.FileType.File);
  assert.strictEqual(stat.size, fs.statSync(path.join(dotssh, 'config')).size);
  console.log('  ok   ssh://app-cmd/ file access through ProxyCommand, size', stat.size);

  // 5. Nothing was prompted, nothing was written to the settings
  assert.deepStrictEqual(state.prompts, []);
  // Only the default terminal profile got set, no SSH FS configs or other settings
  assert.deepStrictEqual(Object.keys(state.settings), ['terminal.integrated.defaultProfile.linux']);
  console.log('  ok   no prompts, no settings written (besides the default terminal profile)');

  // 6. Disconnecting works
  await registered.commands['sshfs.disconnectAll']();
  assert.strictEqual((await registered.trees['sshfs-connections'].getChildren()).length, 0);
  console.log('  ok   disconnect all');

  // 7. Nothing connected and no SSH workspace folders: the default profile opens a terminal on this computer
  const local = await registered.profiles['sshfs.terminalProfile.connected'].provideTerminalProfile({});
  assert.ok(local.options.shellPath && !local.options.pty, 'expected a local shell');
  // Disabling sshfs.terminal.defaultToConnectedHost restores the previous default profile
  await vscode.workspace.getConfiguration('sshfs').update('terminal.defaultToConnectedHost', false);
  registered.configChanged.fire({ affectsConfiguration: section => section === 'sshfs.terminal.defaultToConnectedHost' });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(state.settings['terminal.integrated.defaultProfile.linux'].globalValue, undefined);
  console.log('  ok   default profile falls back to this computer without a connected host, and can be turned off');

  fs.rmSync(realHome, { recursive: true, force: true });
  process.exit(0);
})().catch(e => {
  console.error(e);
  console.error(state.log.filter(l => /ERROR|WARN/.test(l)).slice(-10).join('\n'));
  process.exit(1);
});
