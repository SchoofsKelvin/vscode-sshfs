
# Changelog

## v1.26.1 (2023-04-16)

### Changes

- Apply a patch to ssh2 and make use of it to fix OpenSSH 8.8+ disabling `ssh-rsa` (SHA1) by default (#309) (8f62809)
  - Patch file in `.yarn/patches` based on <https://github.com/Eugeny/ssh2/tree/rsa-sha> applied to `ssh2@1.11.0`
  - The patch adds an option `convertSha1` to `publickey` and `agent` authentication methods on top of Eugeny's modifications
    - When the option is present, `ssh-rsa` keys will be treated as `rsa-sha2-512` or `rsa-sha2-256`, if the server supports it
  - Added a flag `OPENSSH-SHA1` (enabled by default) to pass this `convertSha1` flag when using `publickey` or `agent` auths
  - Part of this change required creating a custom ssh2 `authHandler` (based on the built-in version) to pass the option if desired
- Changed the `lastVersion` extension version tracking to a new `versionHistory` system to better track bug origins (5314e21)
- Fix error notifications appearing for missing Python config file (d878b78, #379)
  - The `FS_NOTIFY_ERRORS` flag was supposed to default to `'write'` for VS Code 1.56+ but defaulted to `true` (i.e. `'all'`) instead
  - Added `/pyproject.toml` to the ignore list (added as a `configBasedExtensionTips` in `product.json` in VS Code 1.77)

## v1.26.0 (2023-03-25)

### Changes

- Internally we now have a `subscribeToGlobalFlags` to use up-to-date global flags (1fb7a52)
  - Currently, this makes it that changing the global flags can immediately have an effect for some flags
  - Global flags are those defined in your User Settings or Workspace(Folder) Settings
  - Mind that if you override those flags by specifying them in your SSH FS config, it'll keep using them
- Added the `DEBUG_FS` flag to allow enabling detailed conditional logging in `sshFileSystem` (76a28be, #341)
  - This flag will auto-update when it changes in global flags, unless it's overriden in your SSH FS config
  - Mostly meant for internal debugging or helping with debugging specific user-reported issues
- Added the `DEBUG_FSR` flag to allow enabing detailed conditional logging for the `FileSystemRouter` (7d59992)
  - Similar to `DEBUG_FS` this is mostly meant for internal debugging or when useful for user-reported issues
  - This flag will also auto-update when it changes in global flags.
  - This is a singleton flag and thus unaffected by overriding it in your SSH FS configs
- Improved the above `DEBUG_FS` flag and refactored the already-existing `FS_NOTIFY_ERRORS` flag (20cf037, #341)
  - The `FS_NOTIFY_ERRORS` flag will auto-update when it changes in global flags, unless it's overriden in your SSH FS config
  - The `FS_NOTIFY_ERRORS` flag is now a string representing a comma-separated list instead of just a boolean
  - While disabled by default for older VS Code versions, starting from VS Code 1.56.0 the default is `write`
  - The `write` flag will show a notification should an error happen for a "write" operation
  - Write operations are: `createDirectory`, `writeFile`, `delete`, and `rename`
  - Since `readDirectory`, `readFile` and `stat` are disabled by default, it should prevent extension detection spam (see #341)
- Added the `SHELL_CONFIG` flag to force a specific remote shell configuration (5721f1c, #331)
- Refactored how (and also from where) configuration files are loaded (831a247)
  - The extension is now better at splitting up where it loads configs from into layers (global, workspace, ...)
  - When settings change, only the appropriate layer (e.g. a workspace folder) is reloaded, instead of reloading everything
  - Loading config files from the VS Code settings in remote workspaces is now supported
  - All layers, including (remote) workspace folders should fully support the `sshfs.configpaths` setting
  - Although this can change, for workspace folders, paths specified in the global/workspace settings are also scanned
- Add a new `extend` config option that allows a config to extend one or more other configs (6eff0be, #268)
  - The extension will automatically detect and report missing or cyclic dependencies, skipping them
  - Note that if a config tries to extend a non-existing config, it will be skipped and an error will also be shown
- Start screen of Settings UI will use the cached list of configs instead of reloading them (5900185)
  - This should make navigating to the start screen (especially when navigating back and forth between configs) faster
  - The Refresh button is now renamed to Reload and will still reload the configs (from disk, remote workspaces, ...)
- Add support for extending configs to the Settings UI (a5372a4, #268)
  - This adds a visual editor to the Settings UI for the `extend` config option

### Development changes

- Move the whole flag system from config.ts to flags.ts (11b8f05)
- Updated Yarn to version 3.5.0 (4d389f3)
- Upgrade a ton of dependencies (8909d05)
  - Replace deprecated `vsce` with `@vscode/vsce@^2.18.0`
  - Upgrade TypeScript from ~4.5.5 to ~5.0.2
  - Upgrade Webpack from ^5.69.1 to ^5.76.3
  - Upgrade a bunch of plugins and other dependencies
- Fix linter warnings in Markdown files and remove default webview/README.md (4a62035)
- Fix build workflow to account for incompatibility from using a new `vsce` version (6985ead)
- Updated the GitHub workflows (eac8a06, #372)
  - Added `issue/**` to the `push` and `pull_request` triggers to automatically build on these branches
  - The build workflow upgraded from `ubuntu-18.04` to `ubuntu-22.04`
  - All actions are upgraded to a more recent version
  - Caching of Yarn dependencies is now handled by `actions/setup-node`
  - Migrated from `actions/create-release` and `actions/upload-release-asset` to `softprops/action-gh-release`
- Fix Webpack only listening on IPv6 instead of all interfaces + update VS Code default styles (574d466)
- Added the `FieldList` and derivate `FieldConfigList` field types to the Settings UI (796d1c2)

## v1.25.0 (2022-06-01)

### Major change

- Updated from `ssh2@0.8.9` to `ssh@1.6.0` (2e14709)
  - Part of this update forces me to ditch `ssh2-streams` which played a major role for SFTP
  - The `ssh2` package has a built-in but unexposed alternative we can more or less use directly
  - The `@types/ssh2` is semi-outdated and has lots of inaccuracies, along with missing internal things
  - For this major update a `ssh2.ts` replacing `@types/ssh2` is added to the `common` module
  - This does pull in a lot of new fixes/features added since `ssh2@1.0.0` though
  - Some feature requests are now easier/possible to implement with these new features
- Add initial support for Windows OpenSSH servers (fixes #338) (9410ac2)
  - This adds initial support for Command Prompt, and theoretically PowerShell (untested)
  - The `REMOTE_COMMANDS` is not yet supported, as it uses the pty's `tty` for cross-terminal communication
  - Future `REMOTE_COMMANDS` support for PowerShell (since it can interact with named pipes) is planned
  - Future `REMOTE_COMMANDS` support for Command Prompt is currently not yet planned, but might be possible
  - Mind that some (future) features won't work (maybe just for now, maybe forever) on Windows

### New features

- Added `FS_NOTIFY_ERRORS` flag to display notifications for FS errors (ddfafd5, #282)
- Added a `${workingDirectory}` variable that gets replaced during terminal creation (ddfafd5, #323)
  - This applies to both the `Terminal Command` setting and `ssh-shell` task type
  - See the issue (#323) for why this got added and how you can use it

### Changes

- Small improvements to Dropdown(WithInput) UI components (9c83b07)
- Delay and wait for loadConfigs() after logging version info (8c8b950)
  - This solves a small issue/annoyance where logs regarding loading logs appear before the version logging
- When `${workingDirectory}` is present in a terminal command, the extension doesn't auto-`cd` anymore (749a611)
  - Normally the extension runs `cd <workingDirectory>; <terminalCommand>` or similar
- Auto-silence FileNotFound erors for stat (dc20709, #334)
  - The extension will no longer show notification bubbles for failed `stat` operations due to non-existing files

### Development changes

- Added `semver` as dependency in preparation of `FS_NOTIFY_ERRORS` flag (57b8ec6)
- Pin some dependencies and in-range upgrade recursively (c7ac129)
  - More specifically, we now use `typescript@~version` instead of `typescript@^version`
  - All dependencies are upgraded within their (package.json-specified) ranges, to get latest patches
- Update to Yarn 3.1.1 and TypeScript ~4.5.5 (83cf22a)
  - Also ditched `@yarnpkg/plugin-version` which wasn't even really used in the first place
- Created a `common` module which now holds `fileSystemConfig.ts` and `webviewMessages.ts` (85f7a69)
- Improve webview ESLint setup, namely update `@typescript-eslint/*` and remove unused plugins (2673c72)
- Add prettier and its Yarn PnP SDK integration + VS Code settings (e95c16a)

## v1.24.1 (2021-12-07)

### New features

- The settings UI now has a table-like field to modify `newFileMode` (b904fb9, #214)

### Changes

- The default `newFileMode` is now `0o664` instead defaulting to the underlying library's `0o666` (af76438, #214)
  - **This changes the permission for newly created files**, defaulting to `rw-rw-r--` instead of `rw-rw-rw-`
  - While `0o664` is the default umask for non-root users and `0o644` for root, **we default to `0o664` regardless**

### Development changes

- Fix/improve `map-error.js` utility (now also uses `formatId` from `webpack.plugin.js`) (768bfda)
- Update build process (fa3bc68)
  - Build workflow broke due to using `yarn dlx vsce` and an `vsce` major version update requiring Node 14
  - The workflow is now configured to use Node 14 instead of Node 12
  - `vsce` is now added as a `devDependency`, which will also result in a speedup due to Yarn caching
- The `FieldNumber` component in the webview now doesn't always default to `22` as value (00b52d7)
  - This component is only used for the `port` field, which now passes `22` to `FieldNumber` by default
- Extracted checkbox CSS from `FieldCheckbox` to something generic using CSS classes to allow reuse (10cfa31)
  - Also added `getValueClassName(): string` to `FieldBase` to allow extra classes. Defaults to `"value"`

## v1.24.0 (2021-11-02)

### Changes

- Set `$TERM` to `xterm-256color` instead of the default `vt100` (16ffd1e, #299)
- Terminals that exit within 5 seconds should now remain open until a key is pressed (55d7216)
- Refactored the `REMOTE_COMMANDS` beta feature (#270) to use the new `ShellConfig` system (b9f226e)
  - Commands (currently only `code`) are now written to a unique folder and passed to `$PATH`
  - Commands are written in shell scripts (`#!/bin/sh` shebang) and should work on all shells/systems
  - Using `$PATH` should allow support for recursive shells, switching shells, ...

### Fixes

- Write `REMOTE_COMMANDS` profile script to separate file for each user (69c2370, #292)
  - Multiple users making use of this feature would use the same `/tmp/...` file, resulting in permission issues

### New features

- Added a `ShellConfig` system to support more shells regarding `environment`, home detection and `REMOTE_COMMANDS` (cc823c6)

## v1.23.1 (2021-10-06)

### Hotfix

- Fix the issue with failing home detecting for `csh`/`tcsh` shells (7605237, #295)

### Development changes

- More improvements in logging, especially regarding async stack tracing (e326a16)
  - Properly "set boundaries",  detect/analyze and log `toPromise`/`catchingPromise` calls

## v1.23.0 (2021-10-02)

### Fixes

- Fix remote `code` command (#267) not working without the filesystem already connected (#292) (b821bae)
- Fix bug with broken connections when connections are initiated by spawning named terminals (6f6e3ad)
- Fix issue where `.bashrc` echoing would result in home directory detection failing (860f65a, #294)

### Changes

- Proxy hop field now actually lists all known configs to pick from, instead of "TO DO" (1f7e333, #290)
- Remote `code` command (#267) now prompts to create an empty file for non-existing path (30c213a)
- Remote `code` command (#267) now displays a help message when not providing arguments (518e246)

### Development changes

- Webpack setup has been improved quite a bit, mostly to clean up long ugly paths and make builds deterministic:
  - The custom `ProblemMatcherReporter` plugin is moved to `/webpack.plugin.js` and renamed to `WebpackPlugin`
  - Now both webpack configs (extension and webview) make use of this plugin
  - The plugin has the ability to remap module names/paths, accounting for several things:
    - Paths in the global `/Yarn/Berry/` folder are now displayed as `/yarn/` and are simplified for easier reading
    - Paths in the local `.yarn` folder get the same treatment as global ones, but using `.yarn/` as the prefix
    - Other paths that are located within the (config's) project are made relative to the (config's) project root
  - The plugin enhances the stats printer to use the clean simplified paths instead of e.g. `../../../Yarn/etc`
  - The plugin handles generating chunk ids (`optimization.chunkIds` option)
    - Acts mostly like a simplified version of the built-in `deterministic` option
    - Uses the path remapping, resulting in paths not being different depending on where your global Yarn folder is
    - These deterministic builds result in e.g. the same output chunk filenames
    - Building the same commit on GitHub Actions or your own PC should result in e.g. the same source maps
  - The `excludeModules` is now configured (and better handled) by the plugin
  - Commits: 3d1aff3, 865969f, c121647
- The problem matcher for the `Extension Webview - Watch` task has been simplified and fixed due to the above change (3d1aff3)
- Updated Yarn to 3.0.2 (with manual git issue fix applied) (06c8e21)
- Updated TypeScript to ^4.4.3 (06c8e21)
- Added `enhance-changelog.js`  which add commits to "top-level" items in the changelog's "Unreleased" section (dce279d)

## 1.22.0 (2021-09-21)

### Fixes

- Partially fix issue with debug mode on code-server (05e1b69, #279)

### Development changes

- I've added a `CHANGELOG.md` file to the repository containing the changelog for earlier versions. It'll contain already committed changes that have yet to be released.
- The extension now only enters debug mode when the environment variable `VSCODE_SSHFS_DEBUG` is the (case insensitive) string `"true"`. The `ExtensionContext.extensionMode` provided by Code does not influence this anymore. This is part due to #279, implemented in 05e1b69 which supersedes 48ef229.

## 1.21.2 (2021-08-05)

### Fixes

- Fix bug in connect command with `Root` starting with `~` (803dc59, #280)

### Changes

- Remove `(SSH FS)` label from editor titles (fcbd6d7, #278)

## 1.21.1 (2021-08-01)

### Fixes

- Improve effect of `CHECK_HOME` flag (ef40b07b2d, #277)

### Changes

- Better error handling and `CHECK_HOME` flag support for `tryGetHome` (87d2cf845a)

### Development changes

- Improve `map-error.js` to work for `/dist/extension.js` and error report better (bda36c998c)
- Improve logging of errors through promises (c7f1261311)

## 1.21.0 (2021-07-01)

### Major change (315c255)

- An internal change happened, making URIs now represent an absolute path on the server
- In the past, `ssh://config/some/path` for a config with `/root` as Root would actually point to `/root/some/path` on the remote server
- Now, the Root is ignored, so `ssh://config/some/path` will actually point at `/some/path` on the remote server
- The Root field is now only checked by the "Add as Workspace Folder" and "Open remote SSH terminal" for the default path. In the above example, you'd get the workspace folder `ssh://config/root` and have your terminal open with the current directory being `/root`, assuming you didn't open the terminal by using the context menu in the explorer
- **While this shouldn't affect most people**, it means that people that have saved/open workspaces with configs with a non-`/` Root, it might point at the wrong file/directory. Updating the URI or removing and re-adding the workspace folder should fix it
- This change simplifies a lot of complex code accounting for calculating/validating relative paths, and also allows for future improvements, a good example being a beta feature shown in #267

Fixes:

- Fix proxies breaking when no port is defined (which should default to 22) (a41c435, #266)

New features:

- Added `statusBar/remoteIndicator` (remote button left-bottom) (d3a3640, #260)
See microsoft/vscode#122102 for info and [this](https://code.visualstudio.com/updates/v1_56#_remote-indicator-menu) for an example (with different extensions)
- Add support for environment variables (3109e97, #241)
Currently you have to manually edit your JSON settings files to add environment variables.
This can be done by adding e.g. `"environment": { "FOO": "BAR" }`.
Variables will be `export FOO=BAR`'d (fully escaped) before running the shell command.
This affects both terminals and `ssh-shell` tasks.
- Added a `CHECK_HOME` flag (default: true) to toggle checking the home directory (315c255)
The extension checks whether your home directory (queried using `echo ~`) is a directory. Since some exotic setups might have home-less users, you can add `-CHECK_HOME` as a flag (see #270)
- Add `code` as a remote command to open files/directories locally (7d930d3, #267)
**Still a beta feature** which requires the `REMOTE_COMMANDS` flag (see #270) enabled.
Tries to inject an alias (well, function) named `code` in the remote terminal's shell.
The "command" only accepts a single argument, the (relative or absolute) path to a file/directory.
It will tell the extension (and thus VS Code) to open the file/directory. Files are opened in an editor, directories are added as workspace folders. Errors are displayed in VS Code, **not** your terminal.
Due to how complex and unreliable it is to inject aliases, this feature is still in beta and subject to change.

Minor changes:

- Added `virtualWorkspaces` capabilities to `package.json` (8789dd6)
- Added `untrustedWorkspaces` capabilities (cca8be2, #259, microsoft/vscode#120251)
- The `Disconnect` command now only shows connections to choose from (36a440d)
- Added `resourceLabelFormatters` contribution, for better Explorer tooltips (5dbb36b)
- Added `viewsWelcome` contribution, to fill in empty configs/connections panes (4edc2ef)

Development changes:

- Added some initial when clause contexts (b311fec)
  - Currently only `sshfs.openConnections`, `sshfs.openTerminals` and `sshfs.openFileSystems`
- Some small refactors and improvements (5e5286d, 06bce85, f17dae8, 1258a8e, f86e33a)

## 1.20.2 (2021-06-28)

### Fixes

- Allow usernames with dashes for instant connection strings (#264, f05108a)
This only affected the "Create instant connection" option within certain commands in the public version of the extension.
This also affected people (manually) using connection strings to interact with file systems or use as `"hop"` within JSON configs.

### New features

- Add config option for agent forwarding (#265, d167ac8)
The settings UI now has a simple checkbox to toggle agent forwarding.
Mind that this automatically gets disabled if you authenticate without an agent!

### Development changes

- Updated to TypeScript 4.3.4
- Updated `defaultStyles.css` for VS Code CSS variables
- Settings UI now supports checkbox fields
- Extension code base now uses webpack 5 instead of webpack 4

## 1.20.1 (2021-04-14)

### Fixes

- Closing connection shouldn't delete workspace folders if a related filesystem exists (cdf0f99)
  Basically you have connection A (with a terminal or so) and connection B (with a file system) both for the same config name.
  Before, closing connection A would also delete/remove the workspace folder, even though connection B still provides the file system.
  With this change, closing a connection won't delete the folder if it detects another connection (for the same name) providing SFTP.
- Add `WINDOWS_COMMAND_SEPARATOR` config flag to support Windows OpenSSH servers (see #255)
  Mind that you'll also need to change `Terminal Command` into e.g. `powershell`, as Windows doesn't support the `$SHELL` variable

### Changes

- The extension now tracks which version was last used (fdb3b66)
  Currently unused, but might be used in the future to notify the user of breaking changes, optionally with auto-fix.
- Config flags can now be specified per config (9de1d03)
  - An example use of this an be seen in #255.
  - **Note**: Configs (and thus their flags) are cached when a connection is created!
    - This means that changes to the config flags won't apply until the connection is closed and a new one is created.
    - The extension already starts a new (parallel) connection when the currently saved config mismatches a running connection's config.
- The extension will now replace task variables (e.g. `remoteWorkspaceFolder`) in `Terminal Command` (#249)
  This does ***not** handle VS Code's built-in "local" task variables like `workspaceFolder`, although support for this could be added later.

## 1.20.0 (2021-03-19)

### New features

- Add task variables for remote files #232 ([example](https://user-images.githubusercontent.com/14597409/111828756-0d326d00-88ec-11eb-9988-0768e1194cca.png))
  - Supported variables (e.g. `${remoteFile}`) can be seen [here](https://github.com/SchoofsKelvin/vscode-sshfs/blob/v1.20.0/src/manager.ts#L216)
  - Some variables support a workspace name as argument, similar to the built-in variables, e.g. `${remoteWorkspaceFolder:FolderName}`
- Add `taskCommand` #235
  - Similar to `terminalCommand`, but for `ssh-shell` tasks
  - Setting it to e.g. `echo A; $COMMAND; echo B` results in the task echoing `A`, running the task command, then echoing `B`

### Development changes

- Switched from official `ssh2-streams` to [Timmmm/ssh2-streams#patch1](https://github.com/Timmmm/ssh2-streams/tree/patch-1)
  - Potentially fixing #244
- Updated to TypeScript 4.2.3
- Updated all other dependencies within the existing specified version range _(minor and patch updates)_
- Build workflow now caches the Yarn cache directory
- Build workflow now uses Node v12 instead of v10
- Added a Publish workflow to publish the extension to VS Marketplace and Open VSX Registry

## 1.19.4 (2021-03-02)

### Changes

- Flag system is improved. The `DF-GE` flag (see #239) will now automatically enable/disable for affected Electron versions.
  People that were making use of the `DF-GE` flag to **disable** this fix, should now use `-DF-GE` or `DF-GE=false` instead.

### Development changes

- GitHub Actions workflow now makes use of the [Event Utilities](https://github.com/marketplace/actions/event-utilities) GitHub action (6d124f8)
  This is mostly the old code, but now better maintained and made publicly available to anyone.
  Doesn't really affect the extension. Just cleans up the workflow file, instead of requiring a relatively big complex chunk of bash script.

## 1.19.3 (2021-02-15)

### Changes

- Instant connections with as hostname an existing config will result in the configs being merged
  - e.g. `user2@my-config` will use the same config as `my-config`, but with `user2` as the user
  - The "instant connection bonuses" are still applied, e.g. trying to match the (new) config against a PuTTY session on Windows
- Typing in a config/connection picker (e.g. the `SSH FS: Open a remote SSH terminal` command) acts smarter for instant connections
  - Entering a value and selecting `Create instant connection` will carry over the entered value to the new input box
- Instant connections are now much better at matching against PuTTY sessions
  - The discovery process of PuTTY sessions will no longer spam the output _(only "interesting" fields are outputted)_
  - It will now try to first find a session with the given host as name, then try again by matching username/hostname
  - This improved matching should also work for non-instant connections, aka regular configurations
- Overhauled README with updated graphics, list of features, ...
- Fixed a bug regarding the `SFTP Sudo` config field misbehaving in the config editor

### Other news

I'm in the process of claiming the "Kelvin" namespace on the Open VSX Registry.
In the future, new versions will also be pushed to it, instead of relying on their semi-automated system to do it _sometime_.

## 1.19.2 (2021-02-11)

### Hotfix

- Add an auto-enabled patch for #239
  - Disables all `diffie-hellman-group-exchange` KEX algorithms _(unless the user overrides this option)_
  - Adding the flag `DF-GE` to your `sshfs.flags`, e.g. `"sshfs.flags": ["DF-GE"]` **disables** this fix

### New features

- **Instant connections**
  - The "Add as Workspace Folder" and "Open remote SSH terminal" now suggest "Create instant connection"
  - Allows easily setting up unconfigured connections, e.g. `user@example.com:22/home/user`
  - The connection string supports omitting user (defaults to `$USERNAME`), port (22) and path (`/`)
  - On Windows, the extension will automatically try to resolve it to a PuTTY session (e.g. `user@SessionName/home/user`)
    - This part is still not fully finished, and currently has bugs. Use `user@domain.as.configured.in.putty` to make it work
    - Better support for PuTTY will be added soon
  - A workspace file can add instant connections as workspace folders by using the instant connection string
    - If the connecting string does **not** contain a `@`, it's assumed to be a config name _(old default behavior)_
  - Roadmap: once #107 is fully added, instant connections will also support OpenSSH config files, similar to PuTTY support
- Flag system, available under the `sshfs.flags` config option.
Allows specifying flags to change certain options/features that aren't supported by the UI.
- Adding `"debug": true` to your SSH FS config will enable `ssh2`/`ssh2-streams` debug logging for that config

### Development changes

- The GitHub repository now has a workflow (GitHub Actions) to build the extension and draft releases
- Improve how the extension "simplifies" error messages for missing files for (built-in) extension checks
  - Now supports workspace folders with `ssh://name/path` as URI instead of just `ssh://name/`
  - Added `/app/src/main/AndroidManifest.xml` to the ignore list (recently added in VS Code itself)
- WebView went through a small refactorization/cleanup, to make future work on it easier
  - Unused files removed, small basically identical files merged, ...
  - Switch from deprecated `react-scripts-ts` to `react-scripts` (with ESLint support)
  - Removed the custom `react-dev-utils` module _(was required for `react-scripts-ts` with VS Code)_
  - Fix problemMatcher for the webview watch build task
- Remove `streams.ts` + simplify `tryGetHome` in `manager.ts` to not depend on it anymore

## 1.19.1 (2020-12-17)

### New features

- Add TerminalLinkProvider for absolute paths

### Changes

- Upgrade `@types/vscode` and minimum VSCode version from 1.46.0 to 1.49.0
- Small internal improvements
- Fix some bugs

## 1.19.0 (2020-12-17)

### New features

- `SSH FS` view with nice UI for listing configs, managing connections/terminals, ...
- Support prompting the `Host` field
- Add `Terminal command` field to change the terminal launch command _(defaults to `$SHELL`)_

### Changes

- Upgrade codebase to typescript@4.0.2
- Refactor Manager, add ConnectionManager
- Small bug fixes, improved logging, ...

## Earlier

Check the [releases](https://github.com/SchoofsKelvin/vscode-sshfs/releases) page to compare commits for older versions.
