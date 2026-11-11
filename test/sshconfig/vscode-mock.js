// A minimal stand-in for the `vscode` module, just enough to run the extension's config/connection code under Node
const fs = require('fs');
const path = require('path');

class Uri {
  constructor(scheme, authority, p) { this.scheme = scheme; this.authority = authority; this.path = p; }
  get fsPath() { return this.path; }
  static file(p) { return new Uri('file', '', p); }
  static parse(str) {
    const m = /^([a-zA-Z0-9+.-]+):\/\/([^/]*)(\/.*)?$/.exec(str);
    if (!m) return new Uri('file', '', str);
    return new Uri(m[1], m[2], m[3] || '/');
  }
  static joinPath(uri, ...parts) { return new Uri(uri.scheme, uri.authority, path.posix.join(uri.path, ...parts)); }
  with(change) { return new Uri(change.scheme || this.scheme, change.authority || this.authority, change.path || this.path); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

class EventEmitter {
  constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose() { } }; }; }
  fire(v) { this.listeners.forEach(l => l(v)); }
}

const state = {
  /** Values for `getConfiguration().inspect()`: { 'sshfs.configs': { globalValue: [...] } } */
  settings: {},
  /** Answers for showInputBox, in order. Functions get called with the options */
  inputAnswers: [],
  /** Every showInputBox call that happened */
  prompts: [],
  messages: [],
  log: [],
  trusted: true,
};

const noop = () => undefined;
const disposable = { dispose: noop };

const vscode = {
  __state: state,
  Uri, EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { One: 1 },
  TaskScope: { Workspace: 2 },
  ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } static Folder = { id: 'folder' }; },
  Range: class Range { constructor(...a) { this.args = a; } },
  FileSystemError: class FileSystemError extends Error {
    static FileNotFound(uri) { const e = new this(`FileNotFound ${uri}`); e.code = 'FileNotFound'; return e; }
    static FileNotADirectory(uri) { const e = new this(`FileNotADirectory ${uri}`); e.code = 'FileNotADirectory'; return e; }
    static NoPermissions(uri) { const e = new this(`NoPermissions ${uri}`); e.code = 'NoPermissions'; return e; }
    static Unavailable(uri) { const e = new this(`Unavailable ${uri}`); e.code = 'Unavailable'; return e; }
  },
  Disposable: class Disposable { constructor(fn) { this.dispose = fn || (() => { }); } },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  version: '1.123.0',
  workspace: {
    get isTrusted() { return state.trusted; },
    workspaceFolders: undefined,
    fs: {
      readFile: async uri => fs.promises.readFile(uri.fsPath),
      writeFile: async (uri, data) => fs.promises.writeFile(uri.fsPath, data),
      stat: async uri => { const s = await fs.promises.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1 }; },
      readDirectory: async uri => (await fs.promises.readdir(uri.fsPath, { withFileTypes: true })).map(e => [e.name, e.isDirectory() ? 2 : 1]),
      createDirectory: async uri => fs.promises.mkdir(uri.fsPath, { recursive: true }),
    },
    getConfiguration(section) {
      return {
        inspect(key) { return state.settings[`${section}.${key}`] || {}; },
        get(key, fallback) { const i = state.settings[`${section}.${key}`] || {}; return i.globalValue ?? fallback; },
        async update(key, value) { (state.settings[`${section}.${key}`] ||= {}).globalValue = value; },
      };
    },
    onDidChangeConfiguration: () => disposable,
    onDidChangeWorkspaceFolders: () => disposable,
    registerFileSystemProvider: () => disposable,
    updateWorkspaceFolders: noop,
    getWorkspaceFolder: noop,
  },
  window: {
    createOutputChannel: () => ({ appendLine: line => state.log.push(line), show: noop }),
    async showInputBox(options) {
      state.prompts.push(options.prompt);
      const answer = state.inputAnswers.shift();
      return typeof answer === 'function' ? answer(options) : answer;
    },
    showErrorMessage: async (...args) => { state.messages.push(['error', ...args]); },
    showWarningMessage: async (...args) => { state.messages.push(['warning', ...args]); },
    showInformationMessage: async (...args) => { state.messages.push(['info', ...args]); },
    createTreeView: () => disposable,
    registerTerminalLinkProvider: () => disposable,
    createTerminal: () => ({ show: noop }),
    terminals: [],
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
  tasks: { registerTaskProvider: () => disposable },
  extensions: { getExtension: noop },
};

module.exports = vscode;
