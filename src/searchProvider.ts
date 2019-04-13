
import * as minimatch from 'minimatch';
import { posix as path } from 'path';
import * as vscode from 'vscode';
import { ConcurrencyLimiter } from './concurrencyLimiter';
import { Manager } from './manager';

function textSearchQueryToRegExp(query: vscode.TextSearchQuery): RegExp {
  const flags = `${query.isCaseSensitive ? '' : 'i'}mug`;
  let pattern = query.pattern;
  if (query.isRegExp) {
    if (query.isWordMatch) pattern = `\\b${query.pattern}\\b`;
    return new RegExp(pattern, flags);
  }
  pattern = pattern.replace(/\\/g, '\\\\');
  if (query.isWordMatch) pattern = `\\b${query.pattern}\\b`;
  return new RegExp(pattern, flags);
}

type RegExpMatchHandler = (lastIndex: number, mach: RegExpExecArray) => true | null | undefined | void;
function forEachMatch(content: string, regex: RegExp, handler: RegExpMatchHandler) {
  let mat = regex.exec(content);
  while (mat) {
    const { lastIndex } = regex;
    if (handler(lastIndex, mat)) break;
    mat = regex.exec(content);
  }
}

type SimpleRange = [number, number];
function getSearchResultRanges(content: string, query: vscode.TextSearchQuery, options: vscode.TextSearchOptions, regex: RegExp): SimpleRange[] {
  const results: SimpleRange[] = [];
  if (query.isMultiline) {
    forEachMatch(content, /[^\r\n]+/g, (index, mat) => {
      const res = getSearchResultRanges(mat[0], query, options, regex);
      res.forEach(range => (range[0] += index, range[1] += index));
      results.push(...res);
    });
    return results;
  }
  forEachMatch(content, regex, (index, mat) => {
    results.push([index - mat[0].length, index]);
  });
  return results;
}

function getSearchResults(content: string, query: vscode.TextSearchQuery, options: vscode.TextSearchOptions, regexp: RegExp): vscode.Range[] {
  const indexes = getSearchResultRanges(content, query, options, regexp);
  const indexForLine: number[] = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      indexForLine.push(i + 1);
    }
  }
  return indexes.map((range) => {
    const startLine = indexForLine.findIndex(v => v >= range[0]) - 1;
    const endLine = indexForLine.findIndex(v => v >= range[1]) - 1;
    const startChar = range[0] - indexForLine[startLine];
    const endChar = range[1] - indexForLine[endLine];
    return new vscode.Range(startLine, startChar, endLine, endChar);
  });
}

export class SearchProvider implements vscode.FileSearchProvider, vscode.TextSearchProvider {
  protected cache: [vscode.CancellationToken, Promise<vscode.Uri[]>][] = [];
  constructor(protected manager: Manager) { }
  public async provideFileSearchResults(query: vscode.FileSearchQuery, options: vscode.FileSearchOptions, token: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const { folder, session } = options;
    const paths = await this.getTree(options, session || token, !session);
    if (token.isCancellationRequested) return [];
    const pattern = query.pattern.toLowerCase();
    return paths.map<vscode.Uri | false>((relative) => {
      return relative.path.toLowerCase().includes(pattern) && relative;
    }).filter(s => !!s) as vscode.Uri[];
  }
  public async provideTextSearchResults(query: vscode.TextSearchQuery, options: vscode.TextSearchOptions, progress: vscode.Progress<vscode.TextSearchResult>, token: vscode.CancellationToken): Promise<vscode.TextSearchComplete> {
    const paths = await this.getTree(options, token, true);
    const regexp = textSearchQueryToRegExp(query);
    const limiter = new ConcurrencyLimiter(20);
    token.onCancellationRequested(limiter.clear, limiter);
    let found = 0;
    const fs = (await this.manager.getFs(options.folder))!;
    async function handleFile(uri: vscode.Uri) {
      if (token.isCancellationRequested) return;
      if (options.maxFileSize) {
        const stats = await fs.stat(uri);
        if (stats.size > options.maxFileSize) return;
      }
      const buffer = Buffer.from(await fs.readFile(uri));
      const content = Buffer.from(buffer.toString(), options.encoding);
      const ranges = getSearchResults(content.toString(), query, options, regexp);
      found += getSearchResults.length;
      progress.report({
        ranges, uri,
        preview: {
          matches: ranges,
          text: content.toString(),
        },
      } as vscode.TextSearchMatch);
      if (found >= options.maxResults) limiter.clear();
    }
    for (const filepath of paths) {
      limiter.addTask(() => handleFile(filepath));
    }
    await limiter.toPromise();
    return { limitHit: found > options.maxResults };
  }
  protected async getTree(options: vscode.SearchOptions, session: vscode.CancellationToken, singleton = false): Promise<vscode.Uri[]> {
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
    // TODO: For the options, actually use the following: includes, useIgnoreFiles and useGlobalIgnoreFiles
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
          // tslint:disable-next-line:no-bitwise
          if ((type & vscode.FileType.SymbolicLink) && !options.followSymlinks) return;
          return readDirectory(uri.with({ path: joined }));
        } else {
          res.push(uri.with({ path: joined }));
        }
      }));
    }
    await readDirectory(folder);
    if (options.includes.length) {
      const includes = options.includes.map(e => minimatch.makeRe(e, { nocase: true }));
      const include = (p: string) => includes.some(reg => reg.test(p));
      return res.filter(uri => include(uri.path) || uri.path[0] === '/' && include(uri.path.slice(1)));
    }
    return res;
  }
}
