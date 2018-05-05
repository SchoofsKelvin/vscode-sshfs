
# SSH FS

This extension makes use of the new FileSystemProvider, added in version 1.23.0 of Visual Studio Code.

## Usage
Add SSH FS configs to "sshfs.configs" in your User Settings:
```js
{
  "sshfs.configs": [
    {
        // Both display name and what results in ssh://serverlogs/
        "name": "serverlogs",
        // Remote folder to use as root (default is /)
        "root": "/var/log",
        // Host to connect to (domain / IPv4 / IPv6)
        "host": "10.0.0.123",
        // Port to connect to (default is 22)
        "port": 22,
        // Username to login with
        "username": "root",

        // Path to ssh-agent's UNIX socket
        // or 'pageant' when using Pageant on Windows
        "agent": "pageant"
        
        // Instead of using an agent, we can also just use a password
        "password": "CorrectHorseBatteryStaple"
        
        // Or a private key (raw key, OpenSSH format)
        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnN...",
        // Should the private key be encrypted
        "passphrase": "CorrectHorseBatteryStaple"
    }
  ],
}
```
*You could also put them in Workspace settings, it merges instead of overrides*

**The name has to be a certain format, creating a new configuration using the Command Pallet (or rightclicking the `SSH File Systems` view) is recommended.** Think of the name as an internet domain name, and you'll be more than fine.

Either rightclick to Connect or use the command panel

![Using the Command Panel](./media/screenshot-commandpanel.png)

This will add a Workspace folder linked to a SSH (SFTP) session:

![Workspace folder added](./media/screenshot-explorer.png)

## TO DO *(in order of most likely to implement first)*
* Fix bug where the Explorer shows a loading bar forever
* Fix bug where VSCode shows an error message about `no provider for ssh://NAME/`
* An icon for the extension
* Configuring a deleted (but active) configuration should show the old config
    * Currently it'll open a new default configuration file for it
* Better error handling
    * Everything *seems* fine, but I haven't tested (a lot of) error situations
    * Handles wrong password/key/... properly
    * Doesn't report when `root` is set to a non-existant directory
    * Doesn't (always?) report errors related to lacking permissions
* Offer reconnecting if the User Settings change
    * Currently this only refreshes the `SSH File Systems` view
    * We do offer this when it's changed using Configure in the context menu
* Icons for the `SSH File Systems` view
    * Icon for a configuration that isn't active
    * Icon for a configuration that's active and connected
    * Icon for a configuration that's active but disconnected
    * Variant for the above two for deleted configurations
* Better authentication methods
    * Currently (basically) everything is directly passed to [ssh2](https://www.npmjs.com/package/ssh2#client-methods)
    * Add `promptForPasswordOrPassphrase` *(self-explanatory)*
    * Add `privateKeyPath` *(or auto-detect `privateKey` as a path)*
    * Prompt the user for a passworf if the server prompts
        * This would be the `tryKeyboard` option for ssh2's Client.connect
        * Would need to hook into the keyboard request and show a prompt
* Add an option to open a SSH terminal *(might as well)*
* Add an option to change the `root` folder (without reconnecting)
    * Internally keep track of the original root folder (reset option)
    * Allow to "move" the `root` folder up one directory or to `/`
    * Add a context menu option for directories in the Explorer
