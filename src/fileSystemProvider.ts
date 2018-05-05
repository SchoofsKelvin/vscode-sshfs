/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class File implements vscode.FileStat {

  public type: vscode.FileType;
  public ctime: number;
  public mtime: number;
  public size: number;

  public name: string;
  public data: Uint8Array;

  constructor(name: string) {
    this.type = vscode.FileType.File;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
  }
}

export class Directory implements vscode.FileStat {

  public type: vscode.FileType;
  public ctime: number;
  public mtime: number;
  public size: number;

  public name: string;
  public entries: Map<string, File | Directory>;

  constructor(name: string) {
    this.type = vscode.FileType.Directory;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    this.entries = new Map();
  }
}

export type Entry = File | Directory;

export class MemFs implements vscode.FileSystemProvider {

  public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
  public root = new Directory('');

  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private bufferedEvents: vscode.FileChangeEvent[] = [];
  private fireSoonHandle: NodeJS.Timer;

  constructor() {
    this.onDidChangeFile = this.emitter.event;
  }

  public stat(uri: vscode.Uri): vscode.FileStat {
    return this.lookup(uri, false);
  }

  public readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const entry = this.lookupAsDirectory(uri, false);
    const result: [string, vscode.FileType][] = [];
    for (const [name, child] of entry.entries) {
      result.push([name, child.type]);
    }
    return result;
  }

    // --- manage file contents

  public readFile(uri: vscode.Uri): Uint8Array {
    return this.lookupAsFile(uri, false).data;
  }

  public writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
    const basename = path.posix.basename(uri.path);
    const parent = this.lookupParentDirectory(uri);
    let entry = parent.entries.get(basename);
    if (entry instanceof Directory) {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    if (!entry && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!entry) {
      entry = new File(basename);
      parent.entries.set(basename, entry);
      this.fireSoon({ uri, type: vscode.FileChangeType.Created });
    }
    entry.mtime = Date.now();
    entry.size = content.byteLength;
    entry.data = content;

    this.fireSoon({ uri, type: vscode.FileChangeType.Changed });
  }

    // --- manage files/folders

  public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {

    if (!options.overwrite && this.lookup(newUri, true)) {
      throw vscode.FileSystemError.FileExists(newUri);
    }

    const entry = this.lookup(oldUri, false);
    const oldParent = this.lookupParentDirectory(oldUri);

    const newParent = this.lookupParentDirectory(newUri);
    const newName = path.posix.basename(newUri.path);

    oldParent.entries.delete(entry.name);
    entry.name = newName;
    newParent.entries.set(newName, entry);

    this.fireSoon(
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        );
  }

  public delete(uri: vscode.Uri): void {
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    const basename = path.posix.basename(uri.path);
    const parent = this.lookupAsDirectory(dirname, false);
    if (!parent.entries.has(basename)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    parent.entries.delete(basename);
    parent.mtime = Date.now();
    parent.size -= 1;
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Deleted });
  }

  public createDirectory(uri: vscode.Uri): void {
    const basename = path.posix.basename(uri.path);
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    const parent = this.lookupAsDirectory(dirname, false);

    const entry = new Directory(basename);
    parent.entries.set(entry.name, entry);
    parent.mtime = Date.now();
    parent.size += 1;
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri: dirname }, { uri, type: vscode.FileChangeType.Created });
  }

  public watch(resource: vscode.Uri, opts): vscode.Disposable {
        // ignore, fires for all changes...
    return new vscode.Disposable(() => { });
  }

  private lookup(uri: vscode.Uri, silent: false): Entry;
  private lookup(uri: vscode.Uri, silent: boolean): Entry | undefined;
  private lookup(uri: vscode.Uri, silent: boolean): Entry | undefined {
    const parts = uri.path.split('/');
    let entry: Entry = this.root;
    for (const part of parts) {
      if (!part) {
        continue;
      }
      let child: Entry | undefined;
      if (entry instanceof Directory) {
        child = entry.entries.get(part);
      }
      if (!child) {
        if (!silent) {
          throw vscode.FileSystemError.FileNotFound(uri);
        } else {
          return undefined;
        }
      }
      entry = child;
    }
    return entry;
  }

  private lookupAsDirectory(uri: vscode.Uri, silent: boolean): Directory {
    const entry = this.lookup(uri, silent);
    if (entry instanceof Directory) {
      return entry;
    }
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  private lookupAsFile(uri: vscode.Uri, silent: boolean): File {
    const entry = this.lookup(uri, silent);
    if (entry instanceof File) {
      return entry;
    }
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }

  private lookupParentDirectory(uri: vscode.Uri): Directory {
    const dirname = uri.with({ path: path.posix.dirname(uri.path) });
    return this.lookupAsDirectory(dirname, false);
  }

  private fireSoon(...events: vscode.FileChangeEvent[]): void {
    this.bufferedEvents.push(...events);
    clearTimeout(this.fireSoonHandle);
    this.fireSoonHandle = setTimeout(() => {
      this.emitter.fire(this.bufferedEvents);
      this.bufferedEvents.length = 0;
    },                               5);
  }
}
