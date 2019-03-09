
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'request';
import * as vscode from 'vscode';
import { deleteConfig, loadConfigsRaw, updateConfig } from './config';
import { getLocations } from './fileSystemConfig';
import { Message } from './webviewMessages';

let webviewPanel: vscode.WebviewPanel | undefined;

const DEBUG: number | undefined = 3000;

export function open(extensionPath: string) {
  if (!webviewPanel) {
    webviewPanel = vscode.window.createWebviewPanel('sshfs-settings', 'SSH-FS Settings', vscode.ViewColumn.One, { enableScripts: true });
    webviewPanel.onDidDispose(() => webviewPanel = undefined);
    webviewPanel.webview.onDidReceiveMessage(handleMessage);
    if (DEBUG) {
      // webviewPanel.webview.html = `<html><head><script>document.location="http://localhost:${DEBUG}/"</script></head></html>`;
      const URL = `http://localhost:${DEBUG}/`;
      request.get(URL, (err, res, body) => {
        body = body.replace(/\/static\/js\/bundle\.js/, `http://localhost:${DEBUG}/static/js/bundle.js`);
        webviewPanel!.webview.html = body; // `<html><head><title>Test</title></head><body>Testing</body></html>`;// body
      });
    } else {
      const content = fs.readFileSync(path.resolve(extensionPath, 'resources/settings.html')).toString();
      webviewPanel.webview.html = content.replace(/\$ROOT/g, vscode.Uri.file(path.join(extensionPath, 'resources')).with({ scheme: 'vscode-resource' }).toString());
    }
  }
  webviewPanel.reveal();
}

function postMessage(message: Message) {
  if (!webviewPanel) return;
  webviewPanel.webview.postMessage(message);
}

async function handleMessage(message: Message): Promise<any> {
  console.log('Got message:', message);
  switch (message.type) {
    case 'requestData': {
      const configs = await loadConfigsRaw();
      const locations = getLocations(configs);
      return postMessage({
        configs, locations,
        type: 'responseData',
      });
    }
    case 'saveConfig': {
      const { uniqueId, config, name, remove } = message;
      let error: string | undefined;
      try {
        if (remove) {
          await deleteConfig(config);
        } else {
          await updateConfig(config, name);
        }
      } catch (e) {
        error = e.message;
      }
      return postMessage({
        uniqueId, config, error,
        type: 'saveConfigResult',
      });
    }
    case 'promptPath': {
      const { uniqueId } = message;
      let uri: vscode.Uri | undefined;
      let error: string | undefined;
      try {
        const uris = await vscode.window.showOpenDialog({});
        if (uris) [uri] = uris;
      } catch (e) {
        error = e.message;
      }
      return postMessage({
        uniqueId,
        path: uri && uri.fsPath,
        type: 'promptPathResult',
      });
    }
  }
}
