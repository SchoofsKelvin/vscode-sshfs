
# SSH FS

![Logo](./resources/Logo.png)

[![GitHub package version](https://img.shields.io/github/last-commit/SchoofsKelvin/vscode-sshfs.svg)](https://github.com/SchoofsKelvin/vscode-sshfs) 
[![Visual Studio Marketplace](https://img.shields.io/vscode-marketplace/d/Kelvin.vscode-sshfs.svg)](https://marketplace.visualstudio.com/items?itemName=Kelvin.vscode-sshfs)
 [![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=RLYCWPYEC5WZL)


This extension makes use of the new FileSystemProvider, added in version 1.23.0 of Visual Studio Code. It allows "mounting" a remote folder over SSH as a local Workspace folder.

## Summary
* Use a remote directory (over SSH) as workspace folder
* Use agents, including Pageant for Windows
* Use private keys (any supported by ssh2-streams, including PuTTY's PPK)
* Get prompted for a password/passphrase (plain text password aren't required)
* Easily create configurations that reference a PuTTY session/configuration
* Have multiple SSH (and regular) workspace folders at once
* Make use of SOCKS 4/5 proxies and connection hopping

## Note
There is a [bug in VSCode 1.23.0](https://github.com/Microsoft/vscode/issues/49258) related to configurations. This results in configurations that get added/removed to/from the global settings not showing up/disappearing until reload.

## Usage
Add SSH FS configs to "sshfs.configs" in your User Settings:
```js
{
  "sshfs.configs": [
    {
        // With PuTTY, this can be a complete configuration (with / as root)
        "name": "quick-putty",
        "putty": "My PuTTY session",

        // if "putty" is set to true, it'll use the "name" as session name
        "putty": true // Would use the "quick-putty" PuTTY session
    },
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

        // Username, agent, ... replace environment variables, so
        // you can use the SSH_AUTH_SOCK (or any other) variable
        // (variables can be anywhere in the string)
        "agent": "$SSH_AUTH_SOCK",
        
        // Instead of using an agent, we can also just use a password
        "password": "CorrectHorseBatteryStaple",
        // We can also make the extension prompt us for it instead
        "password": true,
        

        // Or a private key (raw key, OpenSSH format)
        // (can also be a public key for host-based authentication)
        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnN...",
        // It's a lot easier to use a path, though
        "privateKeyPath": "/root/.ssh/myPrivateKey",
        // Also supports PPK keys
        "privateKeyPath": "C:/Users/Kelvin/.ssh/myPrivateKey.ppk",
        // Should the private key be encrypted
        "passphrase": "CorrectHorseBatteryStaple",
        // Same as with the password, we can let it prompt us
        "passphrase": true
    }
  ],
}
```
**See auto-complete while in the settings screen for the "full documentation" about all options**

*You could also put them in Workspace settings. All configurations from Global/Workspace/... settings get merged. Should configurations with the same name exist, the more "lower/specific" configuration gets chosen, e.g. Workspace over Global.*

There's an extensive JSON schema, so it'll say when you're missing a field. Mind that when you have to use e.g. either "host" or "putty", VSCode will only say "Missing host". Check your intellisense/autocomplete for all possible options.

**The name has to be a certain format, creating a new configuration using the Command Pallet (or rightclicking the `SSH File Systems` view) is recommended.** Think of the name as an internet domain name, and you'll be more than fine.

Either rightclick to Connect or use the command panel

![Using the Command Panel](./media/screenshot-commandpanel.png)

This will add a Workspace folder linked to a SSH (SFTP) session:

![Workspace folder added](./media/screenshot-explorer.png)

