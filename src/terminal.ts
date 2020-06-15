import * as vscode from 'vscode';
import * as Logging from './logging';
import { FileSystemConfig } from './fileSystemConfig';

//export async function openTerminal(name: string) {
export async function openTerminal(config: FileSystemConfig) {
    Logging.info(`Command received to open terminal to ${config.name}`);
    let connectionMethod = "password";
    let ssh = 'ssh ' + config.host + ' -l ' + config.username;
    if (config.port !== 22 && config.port !== undefined && config.port) ssh += ' -p ' + config.port;
    Logging.debug(`\Opening terminal to ${ssh}`);
    // Add to be private key path because of vulnerability leak we can't pass private key by command
    if (config.privateKeyPath !== undefined && config.privateKeyPath) {
        connectionMethod = "privateKey";
        ssh += ' -i ' + config.privateKeyPath;
    }
    if (config.agent !== undefined && config.agent) connectionMethod = "agent";
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders && folders.find(f => f.uri.scheme === 'ssh' && f.uri.authority === config.name);
    if (folder) {
        var terminal = vscode.window.createTerminal(`SSH Terminal - ${config.name}`);
        terminal.sendText(ssh);
        if (config.password !== undefined && config.password && connectionMethod === "password") {
            terminal.sendText(config.password);
        }
        if (config.root !== undefined && config.root) terminal.sendText('cd ' + config.root);
        else terminal.sendText('cd $HOME');

        terminal.show();
    }
}
