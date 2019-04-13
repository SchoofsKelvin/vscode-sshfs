
import { posix as path } from 'path';
import { createInterface } from 'readline';
import { ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { Manager } from './manager';
import { toPromise } from './toPromise';

export class SearchProvider implements vscode.FileSearchProvider {
  protected cache: [vscode.CancellationToken, Promise<string[]>][] = [];
  constructor(protected manager: Manager) { }
  public async provideFileSearchResults(query: vscode.FileSearchQuery, options: vscode.FileSearchOptions, token: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const { folder, session = token } = options;
    let cached = this.cache.find(([t]) => session === t);
    if (!cached) {
      cached = [session, this.buildTree(options, session)] as SearchProvider['cache'][0];
      this.cache.push(cached);
      session.onCancellationRequested(() => {
        this.cache.splice(this.cache.indexOf(cached!));
      });
    }
    const paths = await cached[1];
    console.log('Found', paths.length);
    if (token.isCancellationRequested) return [];
    const pattern = query.pattern.toLowerCase();
    return paths.map<vscode.Uri | null>((relative) => {
      if (!relative.toLowerCase().includes(pattern)) return null;
      return folder.with({ path: path.join(folder.path, relative) });
    }).filter(s => !!s) as vscode.Uri[];
  }
  protected async buildTree(options: vscode.FileSearchOptions, token: vscode.CancellationToken): Promise<string[]> {
    const { folder } = options;
    const fs = await this.manager.getFs(folder);
    if (!fs || token.isCancellationRequested) return [];
    const cmd = `ls -AQ1R "${fs.absoluteFromRelative(folder.path)}"`;
    console.log('Creating tree with command:', cmd);
    const exec = await toPromise<ClientChannel>(cb => fs.client.exec(cmd, cb)).catch(() => null);
    if (!exec || token.isCancellationRequested) return [];
    const res: string[] = [];
    const rl = createInterface(exec);
    let root = '';
    rl.on('line', (line: string) => {
      if (!line) return;
      if (line.endsWith(':')) {
        root = JSON.parse(line.substr(0, line.length - 1));
      } else {
        let relative = JSON.parse(line);
        relative = path.join(root, relative);
        relative = fs.relativeFromAbsolute(relative);
        res.push(relative);
      }
    });
    token.onCancellationRequested(rl.close, rl);
    await toPromise(cb => rl.on('close', cb));
    return res;
  }
}
