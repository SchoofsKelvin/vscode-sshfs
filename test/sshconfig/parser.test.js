// Unit tests for the OpenSSH config parser/resolver (no VS Code involved)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2];
const ssh = require(path.join(OUT, 'sshConfig.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshfs-parser-'));
const dotssh = path.join(home, '.ssh');
fs.mkdirSync(path.join(dotssh, 'conf.d'), { recursive: true });
fs.writeFileSync(path.join(dotssh, 'id_ed25519'), 'dummy');
fs.writeFileSync(path.join(dotssh, 'config'), `\uFEFF# My config
Include conf.d/*.conf

Host bastion jump
    HostName bastion.example.com
    User admin
    Port 2222
    IdentityFile ~/.ssh/keys/bastion   # trailing comment
    IdentitiesOnly yes

Host web1 web2
  HostName=%h.internal.example.com
  ProxyJump bastion
  RemoteCommand cd /srv/app && exec $SHELL -l
  SetEnv FOO=bar "BAZ=with space"
  ServerAliveInterval 15
  ConnectTimeout 1m

Host db
  HostName 10.0.0.5
  ProxyCommand ssh -W %h:%p -l %r bastion # not a comment
  ProxyJump ignored-because-proxycommand-came-first
  User "db admin"

Host multi
  ProxyJump first.example.com,second@second.example.com:2200

Host direct.internal.example.com
  ProxyJump none

Host *.internal.example.com !secret.internal.example.com
  ProxyJump bastion
  User deploy

Host nopw
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  IdentityAgent none
  IdentityFile none

Host prefs
  PreferredAuthentications password
  IdentityAgent ~/.1password/agent.sock
  ForwardAgent yes

Match host 10.0.0.* user "db admin"
  Port 5022

Match exec "touch ${home}/EXECUTED"
  User hacked

Match originalhost win* localuser nobody-like-this
  User never

Host weird:name with*wild !negated
  User nope

Host *
  User fallback
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveCountMax 5
`);
fs.writeFileSync(path.join(dotssh, 'conf.d', 'work.conf'), `Host work
  HostName work.example.com
  User me
Host scoped
  Port 1
# This Host block must not leak into the including file
`);
fs.writeFileSync(path.join(dotssh, 'conf.d', 'ignored.txt'), 'Host shouldnotbelisted\n');

const env = { home, username: 'localuser', hostname: 'laptop.lan', uid: '1000', platform: 'linux', env: { SSH_AUTH_SOCK: '/tmp/agent.sock' } };
const warnings = [];

(async () => {
  // Tokenizer
  assert.deepStrictEqual(ssh.tokenize('a "b c" d#x # comment'), ['a', 'b c', 'd#x']);
  assert.deepStrictEqual(ssh.tokenize(`'single q' C:\\Users\\me\\key "esc\\"aped"`), ['single q', 'C:\\Users\\me\\key', 'esc"aped']);
  assert.deepStrictEqual(ssh.tokenize('a\\ b'), ['a b']);
  // Patterns
  assert.ok(ssh.matchPattern('web1.example.com', '*.example.com'));
  assert.ok(!ssh.matchPattern('example.com', '*.example.com'));
  assert.ok(ssh.matchPattern('web1', 'web?'));
  assert.ok(ssh.matchPatternList('a.b', '*.c,a.*'));
  assert.ok(!ssh.matchPatternList('a.b', 'a.*,!*.b'));
  // Jump specs
  assert.deepStrictEqual(ssh.parseJumpSpec('user@host:2222'), { host: 'host', username: 'user', port: 2222 });
  assert.deepStrictEqual(ssh.parseJumpSpec('host'), { host: 'host' });
  assert.deepStrictEqual(ssh.parseJumpSpec('ssh://u@[::1]:22'), { host: '::1', username: 'u', port: 22 });
  assert.deepStrictEqual(ssh.parseJumpSpec('fe80::1'), { host: 'fe80::1' });
  assert.deepStrictEqual(ssh.splitProxyJump('a, b,c'), ['a', 'b', 'c']);

  const loaded = await ssh.loadSshConfig([path.join(dotssh, 'config')], m => warnings.push(m), env);
  // Listing
  const hosts = ssh.listSshHosts(loaded.files).map(h => h.alias);
  assert.deepStrictEqual(hosts, ['work', 'scoped', 'bastion', 'jump', 'web1', 'web2', 'db', 'multi', 'direct.internal.example.com', 'nopw', 'prefs', 'weird:name']);
  const listed = ssh.listSshHosts(loaded.files);
  assert.strictEqual(listed.find(h => h.alias === 'bastion').source.line, 4);
  assert.ok(listed.find(h => h.alias === 'work').source.file.endsWith('work.conf'));
  // Watching includes the included files
  assert.ok(loaded.watch.some(f => f.endsWith('work.conf')));
  assert.ok(!loaded.watch.some(f => f.endsWith('ignored.txt')));

  const get = alias => ssh.getSshHostConfig(loaded, alias, m => warnings.push(m));

  const bastion = get('bastion');
  assert.strictEqual(bastion.host, 'bastion.example.com');
  assert.strictEqual(bastion.username, 'admin');
  assert.strictEqual(bastion.port, 2222);
  assert.deepStrictEqual(bastion.identityFiles, [path.join(dotssh, 'keys', 'bastion'), path.join(dotssh, 'id_ed25519')]);
  assert.strictEqual(bastion.identitiesOnly, true);
  assert.strictEqual(bastion.agent, '/tmp/agent.sock');
  assert.strictEqual(bastion.keepaliveCountMax, 5);
  assert.strictEqual(bastion.proxyJump, undefined);
  assert.strictEqual(get('jump').host, 'bastion.example.com');

  const web1 = get('web1');
  assert.strictEqual(web1.host, 'web1.internal.example.com');
  assert.strictEqual(web1.username, 'fallback'); // `Host *.internal...` matches the alias, not the HostName
  assert.strictEqual(web1.proxyJump, 'bastion');
  assert.strictEqual(web1.remoteCommand, 'cd /srv/app && exec $SHELL -l');
  assert.deepStrictEqual(web1.environment, { FOO: 'bar', BAZ: 'with space' });
  assert.strictEqual(web1.keepaliveInterval, 15000);
  assert.strictEqual(web1.readyTimeout, 60000);
  assert.strictEqual(web1.port, undefined);

  const db = get('db');
  assert.strictEqual(db.host, '10.0.0.5');
  assert.strictEqual(db.username, 'db admin');
  // Tokens that depend on the final connection are left for connect time
  assert.strictEqual(db.proxyCommand, 'ssh -W %h:%p -l %r bastion # not a comment');
  assert.strictEqual(db.proxyJump, undefined);
  assert.strictEqual(db.port, 5022); // from the Match block

  assert.strictEqual(get('multi').proxyJump, 'first.example.com,second@second.example.com:2200');
  assert.strictEqual(get('work').host, 'work.example.com');
  assert.strictEqual(get('work').username, 'me');
  assert.strictEqual(get('work').port, undefined); // `Host scoped` from the included file doesn't leak

  // Wildcard-only hosts (e.g. instant connections)
  const wild = get('api.internal.example.com');
  assert.strictEqual(wild.proxyJump, 'bastion');
  assert.strictEqual(wild.username, 'deploy');
  assert.strictEqual(wild._explicit, true);
  const secret = get('secret.internal.example.com');
  assert.strictEqual(secret.proxyJump, undefined);
  assert.strictEqual(secret.username, 'fallback');
  assert.strictEqual(secret._explicit, false);
  // ProxyJump none wins over a later ProxyJump
  const direct = get('direct.internal.example.com');
  assert.strictEqual(direct.proxyJump, undefined);
  assert.strictEqual(direct.username, 'deploy');

  const nopw = get('nopw');
  assert.deepStrictEqual(nopw._sshAuth, { publickey: true, password: false, keyboard: false });
  assert.strictEqual(nopw.agent, undefined);
  assert.deepStrictEqual(nopw.identityFiles, [path.join(dotssh, 'id_ed25519')]);
  const prefs = get('prefs');
  assert.deepStrictEqual(prefs._sshAuth, { publickey: false, password: true, keyboard: false });
  assert.strictEqual(prefs.agent, path.join(home, '.1password', 'agent.sock'));
  assert.strictEqual(prefs.agentForward, true);

  // Match exec never runs anything
  assert.ok(!fs.existsSync(path.join(home, 'EXECUTED')));
  assert.ok(warnings.some(w => /Match exec/.test(w)), 'expected a warning about Match exec');

  // Default locations & missing files
  const defaults = await ssh.loadSshConfig(undefined, undefined, { ...env, home: path.join(home, 'nope') });
  assert.strictEqual(defaults.files[0].path, path.join(home, 'nope', '.ssh', 'config'));
  assert.strictEqual(defaults.files[0].exists, false);
  assert.deepStrictEqual(ssh.listSshHosts(defaults.files).filter(h => h.source.file.startsWith(home)), []);
  const unknown = ssh.getSshHostConfig(defaults, 'somewhere');
  assert.strictEqual(unknown.host, 'somewhere');
  assert.strictEqual(unknown.username, 'localuser');

  // Windows defaults
  const win = ssh.sshHostToConfig(ssh.resolveSshHost([], 'x', { ...env, platform: 'win32', env: {} }), { ...env, platform: 'win32', env: {} });
  assert.strictEqual(win.agent, '\\\\.\\pipe\\openssh-ssh-agent');

  fs.rmSync(home, { recursive: true, force: true });
  console.log('parser tests: OK');
})().catch(e => { console.error(e); process.exit(1); });
