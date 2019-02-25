
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadConfigs } from './config';

let webviewPanel: vscode.WebviewPanel | undefined;

export function open(extensionPath: string) {
  if (!webviewPanel) {
    webviewPanel = vscode.window.createWebviewPanel('sshfs-settings', 'SSH-FS Settings', vscode.ViewColumn.One, { enableScripts: true });
    webviewPanel.onDidDispose(() => webviewPanel = undefined);
    webviewPanel.webview.onDidReceiveMessage(handleMessage);
    const content = fs.readFileSync(path.resolve(extensionPath, 'resources/settings.html')).toString();
    webviewPanel.webview.html = content.replace(/\$ROOT/g, vscode.Uri.file(path.join(extensionPath, 'resources')).with({ scheme: 'vscode-resource' }).toString());
  }
  webviewPanel.reveal();
}

interface RequestDataMessage {
  type: 'requestData';
}
type Message = { type: 'requestData' } | RequestDataMessage;

async function handleMessage(message: Message): Promise<any> {
  switch (message.type) {
    case 'requestData': {
      return webviewPanel!.webview.postMessage(await loadConfigs());
    }
  }
}
