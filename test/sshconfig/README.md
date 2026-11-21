# Tests for the OpenSSH config support

Plain Node scripts (no VS Code needed). They run the real extension code against in-process SSH servers
(using the server part of `ssh2`), with `vscode-mock.js` standing in for the `vscode` module.

```sh
# Compile the sources to CommonJS
yarn tsc -p . --outDir .test-out --module commonjs --sourceMap false
yarn tsc -p common --outDir .test-out/common --module commonjs --sourceMap false --declaration false --declarationMap false

# Parser/resolver unit tests
yarn node test/sshconfig/parser.test.js "$PWD/.test-out"
# Listing, authentication, ProxyJump, ProxyCommand, RemoteCommand (needs `nc`)
yarn node test/sshconfig/integration.test.js "$PWD" "$PWD/.test-out"
# Smoke test of a packaged build: unzip the .vsix somewhere and pass its `extension` folder
yarn node test/sshconfig/bundle.test.js "$PWD" /path/to/unzipped-vsix/extension
# SSH agent tests of a packaged build: keys loaded in an agent (`ssh-add`) never prompt for a passphrase
yarn node test/sshconfig/agent.test.js "$PWD" /path/to/unzipped-vsix/extension
```
