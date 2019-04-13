
import * as minimatch from 'minimatch';
import { posix as path } from 'path';
import * as vscode from 'vscode';
import { Manager } from './manager';

export class SearchProvider implements vscode.FileSearchProvider {
  protected cache: [vscode.CancellationToken, Promise<vscode.Uri[]>][] = [];
  constructor(protected manager: Manager) { }
  public async provideFileSearchResults(query: vscode.FileSearchQuery, options: vscode.FileSearchOptions, token: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const { folder, session } = options;
    const paths = await this.getTree(options, session || token, !session);
    if (token.isCancellationRequested) return [];
    const pattern = query.pattern.toLowerCase();
    return paths.map<vscode.Uri | null>((relative) => {
      if (!relative.path.toLowerCase().includes(pattern)) return null;
      return folder.with({ path: path.join(folder.path, relative.path) });
    }).filter(s => !!s) as vscode.Uri[];
  }
  protected async getTree(options: vscode.FileSearchOptions, session: vscode.CancellationToken, singleton = false): Promise<vscode.Uri[]> {
    let cached = this.cache.find(([t]) => session === t);
    if (cached) return await cached[1];
    const singletonSource = singleton && new vscode.CancellationTokenSource();
    if (singletonSource) {
      session.onCancellationRequested(singletonSource.cancel, singletonSource);
      singletonSource.token.onCancellationRequested(singletonSource.dispose, singletonSource);
      session = singletonSource.token;
    }
    cached = [session, this.internal_buildTree(options, session)] as SearchProvider['cache'][0];
    this.cache.push(cached);
    session.onCancellationRequested(() => {
      this.cache.splice(this.cache.indexOf(cached!));
    });
    const res = await cached[1];
    if (singletonSource) singletonSource.cancel();
    return res;
  }
  protected async internal_buildTree(options: vscode.FileSearchOptions, token: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const { folder } = options;
    const fs = await this.manager.getFs(folder);
    if (!fs || token.isCancellationRequested) return [];
    const excludes = options.excludes.map(e => minimatch.makeRe(e, { nocase: true }));
    const exclude = (p: string) => excludes.some(reg => reg.test(p));
    const res: vscode.Uri[] = [];
    async function readDirectory(uri: vscode.Uri) {
      if (token.isCancellationRequested) return;
      const entries = await fs!.readDirectory(uri).catch(() => [] as never);
      if (token.isCancellationRequested) return;
      return Promise.all(entries.map(([name, type]) => {
        if (token.isCancellationRequested) return;
        const joined = path.join(uri.path, name);
        if (exclude(joined)) return;
        // tslint:disable-next-line:no-bitwise
        if (type & vscode.FileType.Directory) {
          return readDirectory(uri.with({ path: joined }));
        } else {
          res.push(uri.with({ path: joined }));
        }
      }));
    }
    await readDirectory(folder);
    return res;
  }
}
