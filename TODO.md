
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
    * ~~Add `privateKeyPath`~~ **DONE**
    * Prompt the user for a password if the server prompts
        * This would be the `tryKeyboard` option for ssh2's Client.connect
        * Would need to hook into the keyboard request and show a prompt
* Add an option to open a SSH terminal *(might as well)*
* Add an option to change the `root` folder (without reconnecting)
    * Internally keep track of the original root folder (reset option)
    * Allow to "move" the `root` folder up one directory or to `/`
    * Add a context menu option for directories in the Explorer
