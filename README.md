
# SSH FS

![Logo](./resources/Logo.png)

This extension makes use of the new FileSystemProvider, added in version 1.23.0 of Visual Studio Code.

## Features
* Use a remote directory (over SSH) as workspace folder
* Use agents, including Pageant for Windows
* Get prompted for a password/passphrase (no plain text password in settings)
* Easily create configurations that mirror a PuTTY session
* Have multiple SSH workspace folders at once

## Note
There is a [bug in VSCode 1.23.0](https://github.com/Microsoft/vscode/issues/49258) related to configurations. This results in configurations that get added/removed to/from the global settings not showing up/disappearing until reload.

## Usage
Add SSH FS configs to "sshfs.configs" in your User Settings:
```js
{
  "sshfs.configs": [
    {
        // Unique id, which results in ssh://serverlogs/
        "name": "serverlogs",
        // The label to usually display (uses the name by default)
        "label": "Server logs",
        // Remote folder to use as root (default is /)
        "root": "/var/log",
        // Host to connect to (domain / IPv4 / IPv6)
        "host": "10.0.0.123",
        // Port to connect to (default is 22)
        "port": 22,
        // Username to login with
        "username": "root",


        // Path to ssh-agent's UNIX socket (cygwin ones should work too)
        // or 'pageant' when using Pageant on Windows
        "agent": "pageant",
        
        // Instead of using an agent, we can also just use a password
        "password": "CorrectHorseBatteryStaple",
        // We can also make the extension prompt us for it instead
        "password": true,
        

        // Or a private key (raw key, OpenSSH format)
        // (can also be a public key for host-based authentication)
        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnN...",
        // Should the private key be encrypted
        "passphrase": "CorrectHorseBatteryStaple",
        // Same as with the password, we can let it prompt us
        "passphrase": true
    },
    {
        // If you're on Windows and have PuTTY installed
        "name": "media-server",
        "root": "/data/media/",


        // Either set this to a session name
        "putty": "My media server",

        // Or let it find one using the host (and username)
        "putty": true,
        // Can also be a session name, e.g. "My media server"
        "host": "my.media.me",
        // (Optional) Filter the session by username
        // (This only works if host is NOT a name of a session)
        "username": "media",


        // If the session has an encrypted key
        "passphrase": "CorrectHorseBatteryStaple"

        // Note: If the session doesn't specify a username, but
        // has "Use system username" enabled, it'll use process.env.USER

        // Note: The "agent" option will be set to "pageant" if the
        // session has "Attempt authentication using Pageant" set
    },
    {
        // With PuTTY, this can be a complete configuration (with / as root)
        "name": "quick-putty",
        "putty": "My PuTTY session"
    }
  ],
}
```
*You could also put them in Workspace settings, all entries get merged together in one array.*

There's an extensive JSON schema, so it'll say when you're missing a field. Mind that when you have to use e.g. either "host" or "putty", VSCode will only say "Missing host". Check your intellisense/autocomplete for all possible options.

**The name has to be a certain format, creating a new configuration using the Command Pallet (or rightclicking the `SSH File Systems` view) is recommended.** Think of the name as an internet domain name, and you'll be more than fine.

Either rightclick to Connect or use the command panel

![Using the Command Panel](./media/screenshot-commandpanel.png)

This will add a Workspace folder linked to a SSH (SFTP) session:

![Workspace folder added](./media/screenshot-explorer.png)

## TO DO *(in order of most likely to implement first)*
* ~~Fix bug where saving a file resets the permissions (when owner/root at least)~~ **DONE**
* ~~Allow loading PuTTY sessions when on windows~~ **DONE**
    * Also have a command to directly use a PuTTY session (**TODO**)
* ~~Add proper JSON schema/validation for SSH FS configurations~~ **DONE**
* Fix bug where the Explorer shows a loading bar forever
    * *Seems like I might've fixed this bug over time, but difficult to say*
* Fix bug where VSCode shows an error message about `no provider for ssh://NAME/`
* Allow loading (or automatically use) sessions from .ssh/config
* ~~An icon for the extension~~ **DONE** *(not the best, but eh)*
* ~~Configuring a deleted (but active) configuration should show the old config~~ **DONE**
* Add proxy support for SOCKS 4 and SOCKS 5 **EXPERIMENTAL**
    * A quick test makes it seem like it works
    * Need to check for (common) errors, configuration issues, ...
    * Load proxy config from PuTTY session if given **DONE**
    * Do more tests using (non-)PuTTY sessions, other (public?) proxies, ...
* Better error handling
    * Everything *seems* fine, but I haven't tested (a lot of) error situations
    * ~~Handle wrong password/key/... properly~~ **DONE**
        * Maybe prompt for a password when one's needed but not configured? (**TODO**)
    * Doesn't report when `root` is set to a non-existant directory
    * Doesn't (always?) report errors related to lacking permissions
* Offer reconnecting if the User Settings change
    * Currently this only refreshes the `SSH File Systems` view
    * We do offer this when it's changed using Configure in the context menu
* ~~Icons for the `SSH File Systems` view~~ **DONE**
    * ~~Icon for a configuration that isn't active~~
    * ~~Icon for a configuration that's active and connected~~
    * ~~Icon for a configuration that's active but disconnected~~
    * ~~Variant for the above two for deleted configurations~~
* Better authentication methods
    * Currently (basically) everything is directly passed to [ssh2](https://www.npmjs.com/package/ssh2#client-methods)
    * ~~Add `promptForPasswordOrPassphrase` *(self-explanatory)*~~ **DONE**
        * Both `password` and `passphrase` can be set to `true` to prompt
    * Add `privateKeyPath` *(or auto-detect `privateKey` as a path)*
    * Prompt the user for a password if the server prompts
        * This would be the `tryKeyboard` option for ssh2's Client.connect
        * Would need to hook into the keyboard request and show a prompt
* Add an option to open a SSH terminal *(might as well)*
* Add an option to change the `root` folder (without reconnecting)
    * Internally keep track of the original root folder (reset option)
    * Allow to "move" the `root` folder up one directory or to `/`
    * Add a context menu option for directories in the Explorer
