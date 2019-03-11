
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { deleteConfig, loadConfigsRaw, updateConfig } from './config';
import { getLocations } from './fileSystemConfig';
import { toPromise } from './toPromise';
import { Message } from './webviewMessages';

let webviewPanel: vscode.WebviewPanel | undefined;

// Since the Extension Development Host runs with debugger, we can use this to detect if we're debugging
const DEBUG: number | undefined = process.execArgv.find(a => a.includes('--inspect')) ? 3000 : undefined;
if (DEBUG) console.warn('[vscode-sshfs] Detected we are running in debug mode');

async function getDebugContent(): Promise<string | false> {
  if (!DEBUG) return false;
  const URL = `http://localhost:${DEBUG}/`;
  const request = await import('request').catch(() => null);
  if (!request) throw new Error('Could not load \'request\' library');
  return toPromise<string>(cb => request.get(URL, (err, _, body: string) => {
    if (err) return cb(new Error('Could not connect to React dev server. Not running?'));
    body = body.toString().replace(/\/static\/js\/bundle\.js/, `http://localhost:${DEBUG}/static/js/bundle.js`);
    cb(null, body);
  }));
}

export async function open(extensionPath: string) {
  if (!webviewPanel) {
    webviewPanel = vscode.window.createWebviewPanel('sshfs-settings', 'SSH-FS Settings', vscode.ViewColumn.One, { enableFindWidget: true, enableScripts: true });
    webviewPanel.onDidDispose(() => webviewPanel = undefined);
    webviewPanel.webview.onDidReceiveMessage(handleMessage);
    let content = await getDebugContent().catch((e: Error) => (vscode.window.showErrorMessage(e.message), null));
    if (!content) {
      // If we got here, we're either not in debug mode, or something went wrong (and an error message is shown)
      content = fs.readFileSync(path.resolve(extensionPath, 'webview/build/index.html')).toString();
      // Built index.html has e.g. `href="/static/js/stuff.js"`, need to make it use vscode-resource: and point to the built static directory
      content = content.replace(/\/static\//g, vscode.Uri.file(path.join(extensionPath, 'webview/build/static/')).with({ scheme: 'vscode-resource' }).toString());
    }
    webviewPanel.webview.html = content;
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
