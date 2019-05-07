import * as vscode from 'vscode';
import { loadConfigs } from './config';
import { calculateActualConfig } from './connect';

export async function openTerminal(name: string) {
    var connectionMethod = "password";
    const all = await loadConfigs();
    var config = all.find(c => c.name === name);
    if (!config) {
      throw new Error(`A SSH filesystem with the name '${name}' doesn't exist`);
    }
    config = (await calculateActualConfig(config))!;

    var ssh = 'ssh ' + config.host + ' -l ' + config.username;
    if (config.port !== 22 && config.port !== undefined && config.port) 
      ssh += ' -p ' + config.port;
    // Add to be private key path because of vulnerability leak we can't pass private key by command
    if (config.privateKeyPath !== undefined && config.privateKeyPath) {
        connectionMethod = "privateKey";
        ssh += ' -i ' + config.privateKeyPath; 
    }
    if (config.agent !== undefined && config.agent) 
      connectionMethod = "agent";
    var terminal = vscode.window.createTerminal(config.label || config.name);
    terminal.sendText(ssh);
    
    if (config.password && connectionMethod === "password") 
      setTimeout( () => {
         if (config &&  config.password)
          terminal.sendText(config.password) 
        }, 1000);

    var time = 1000;
    if (config.customTerminalCommands !== undefined && config.customTerminalCommands)            
            config.customTerminalCommands.forEach(element => {
                time = time + 1000;
                setTimeout(() => {terminal.sendText(element)},time);    
            });   

    terminal.show();
}