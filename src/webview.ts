
import { getLocations } from 'common/fileSystemConfig';
import type { Message, Navigation } from 'common/webviewMessages';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { deleteConfig, getConfigs, loadConfigs, updateConfig } from './config';
import { DEBUG, LOGGING_NO_STACKTRACE, Logging as _Logging } from './logging';
import { toPromise } from './utils';

const Logging = _Logging.scope('WebView');

let webviewPanel: vscode.WebviewPanel | undefined;
let pendingNavigation: Navigation | undefined;

function getExtensionPath(): string | undefined {
  const ext = vscode.extensions.getExtension('Kelvin.vscode-sshfs');
  return ext && ext.extensionPath;
}

async function getDebugContent(): Promise<string | false> {
  if (!DEBUG) return false;
  const URL = `http://localhost:3000/`;
  const http = await import('http');
  return toPromise<string>(cb => http.get(URL, async (message) => {
    if (message.statusCode !== 200) return cb(new Error(`Error code ${message.statusCode} (${message.statusMessage}) connecting to React dev server}`));
    let body = '';
    message.on('data', chunk => body += chunk);
    await toPromise(cb => message.on('end', cb));
    body = body.toString().replace(/\/static\/js\/bundle\.js/, `${URL}/static/js/bundle.js`);
    // Make sure the CSP meta tag also includes the React dev server (including connect-src for the socket, which uses both http:// and ws://)
    body = body.replace(/\$WEBVIEW_CSPSOURCE/g, `$WEBVIEW_CSPSOURCE ${URL}`);
    body = body.replace(/\$WEBVIEW_CSPEXTRA/g, `connect-src ${URL} ${URL.replace('http://', 'ws://')};`);
    body = body.replace(/src="\/static\//g, `src="${URL}/static/`);
    cb(null, body);
  }).on('error', err => {
    Logging.warning(`Error connecting to React dev server: ${err}`);
    cb(new Error('Could not connect to React dev server. Not running?'));
  }));
}

export async function open() {
  if (!webviewPanel) {
    const extensionPath = getExtensionPath();
    webviewPanel = vscode.window.createWebviewPanel('sshfs-settings', 'SSH-FS', vscode.ViewColumn.One, { enableFindWidget: true, enableScripts: true });
    webviewPanel.onDidDispose(() => webviewPanel = undefined);
    if (extensionPath) webviewPanel.iconPath = vscode.Uri.file(path.join(extensionPath, 'resources/icon.svg'));
    const { webview } = webviewPanel;
    webview.onDidReceiveMessage(handleMessage);
    let content = await getDebugContent().catch((e: Error) => (vscode.window.showErrorMessage(e.message), null));
    if (!content) {
      if (!extensionPath) throw new Error('Could not get extensionPath');
      // If we got here, we're either not in debug mode, or something went wrong (and an error message is shown)
      content = fs.readFileSync(path.resolve(extensionPath, 'webview/build/index.html')).toString();
      // Built index.html has e.g. `href="/static/js/stuff.js"`, need to make it use vscode-resource: and point to the built static directory
      // Scrap that last part, vscode-resource: is deprecated and we need to use Webview.asWebviewUri
      //content = content.replace(/\/static\//g, vscode.Uri.file(path.join(extensionPath, 'webview/build/static/')).with({ scheme: 'vscode-resource' }).toString());
      content = content.replace(/\/static\//g, webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'webview/build/static/'))).toString());
    }
    // Make sure the CSP meta tag has the right cspSource
    content = content.replace(/\$WEBVIEW_CSPSOURCE/g, webview.cspSource);
    // The EXTRA tag is used in debug mode to define connect-src. By default we can (and should) just delete it
    content = content.replace(/\$WEBVIEW_CSPEXTRA/g, '');
    webview.html = content;
  }
  webviewPanel.reveal();
}

export async function navigate(navigation: Navigation) {
  Logging.debug`Navigation requested: ${navigation}`;
  pendingNavigation = navigation;
  postMessage({ navigation, type: 'navigate' });
  return open();
}

function postMessage<T extends Message>(message: T) {
  webviewPanel?.webview.postMessage(message);
}

async function handleMessage(message: Message): Promise<any> {
  if (!webviewPanel) return Logging.warning`Got message without webviewPanel: ${message}`;
  Logging.debug`Got message: ${message}`;
  if (pendingNavigation) {
    postMessage({
      type: 'navigate',
      navigation: pendingNavigation,
    });
    pendingNavigation = undefined;
  }
  switch (message.type) {
    case 'requestData': {
      const configs = await (message.reload ? loadConfigs : getConfigs)();
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
        Logging.error('Error handling saveConfig message for settings UI:', LOGGING_NO_STACKTRACE);
        Logging.error(JSON.stringify(message), LOGGING_NO_STACKTRACE);
        Logging.error(e);
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
        Logging.error`Error handling promptPath message for settings UI:\n${message}\n${e}`;
        error = e.message;
      }
      return postMessage({
        uniqueId,
        path: uri && uri.fsPath,
        type: 'promptPathResult',
      });
    }
    case 'navigated': {
      const { view } = message;
      type View = 'startscreen' | 'newconfig' | 'configeditor' | 'configlocator';
      let title: string | undefined;
      switch (view as View) {
        case 'configeditor':
          title = 'SSH FS - Edit config';
          break;
        case 'configlocator':
          title = 'SSH FS - Locate config';
          break;
        case 'newconfig':
          title = 'SSH FS - New config';
          break;
      }
      webviewPanel.title = title || 'SSH FS';
    }
  }
}
