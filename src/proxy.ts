
import { spawn } from 'child_process';
import * as dns from 'dns';
import { request } from 'http';
import { Readable, Writable } from 'node:stream';
import { Duplex } from 'stream';
import type { FileSystemConfig } from './fileSystemConfig';
import { Logging } from './logging';
import { toPromise } from './toPromise';

async function resolveHostname(hostname: string): Promise<string> {
  return toPromise<string>(cb => dns.lookup(hostname, cb)).then((ip) => {
    Logging.debug(`Resolved hostname "${hostname}" to: ${ip}`);
    return ip;
  });
}

function validateConfig(config: FileSystemConfig) {
  if (!config.proxy) throw new Error(`Missing field 'config.proxy'`);
  if (!config.proxy.type) throw new Error(`Missing field 'config.proxy.type'`);
  switch (config.proxy.type) {
    case 'http':
    case 'socks4':
    case 'socks5':
      if (!config.proxy.host) throw new Error(`Missing field 'config.proxy.host'`);
      if (!config.proxy.port) throw new Error(`Missing field 'config.proxy.port'`);
      break;
    case 'command':
      if (!config.proxy.command) throw new Error(`Missing field 'config.proxy.command'`);
      break;
    default:
      throw new Error(`Unrecognized proxy type '${config.proxy!.type}'`);
  }
}

export async function socks(config: FileSystemConfig): Promise<NodeJS.ReadWriteStream> {
  Logging.info(`Creating socks proxy connection for ${config.name}`);
  validateConfig(config);
  const proxy = config.proxy!;
  if (proxy!.type !== 'socks4' && proxy!.type !== 'socks5') {
    throw new Error(`Expected 'config.proxy.type' to be 'socks4' or 'socks5'`);
  }
  try {
    const ipaddress = (await resolveHostname(proxy!.host));
    if (!ipaddress) throw new Error(`Couldn't resolve '${proxy!.host}'`);
    Logging.debug(`\tConnecting to ${config.host}:${config.port} over ${proxy!.type} proxy at ${ipaddress}:${proxy!.port}`);
    const con = await (await import('socks')).SocksClient.createConnection({
      command: 'connect',
      destination: {
        host: config.host!,
        port: config.port!,
      },
      proxy: {
        ipaddress,
        port: proxy!.port,
        type: proxy!.type === 'socks4' ? 4 : 5,
      },
    });
    return con.socket as NodeJS.ReadWriteStream;
  } catch (e) {
    throw new Error(`Error while connecting to the the proxy: ${e.message}`);
  }
}

export function http(config: FileSystemConfig): Promise<NodeJS.ReadWriteStream> {
  Logging.info(`Creating http proxy connection for ${config.name}`);
  validateConfig(config);
  return new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
    const proxy = config.proxy!;
    if (proxy!.type !== 'http') {
      return reject(new Error(`Expected config.proxy.type' to be 'http'`));
    }
    try {
      Logging.debug(`\tConnecting to ${config.host}:${config.port} over http proxy at ${proxy!.host}:${proxy!.port}`);
      const req = request({
        port: proxy!.port,
        hostname: proxy!.host,
        method: 'CONNECT',
        path: `${config.host}:${config.port}`,
      });
      req.end();
      req.on('connect', (res, socket) => {
        resolve(socket as NodeJS.ReadWriteStream);
      });
    } catch (e) {
      reject(new Error(`Error while connecting to the the proxy: ${e.message}`));
    }
  });
}

class ReadWriteWrapper extends Duplex {
  constructor(protected _readable: Readable, protected _writable: Writable) {
    super();
    _readable.once('finish', () => this.end());
    _writable.once('end', () => this.push(null));
    _readable.once('error', e => this.emit('error', e));
    _writable.once('error', e => this.emit('error', e));
    this.once('close', () => _writable.end());
  }
  _destroy() { this._readable.destroy(); this._writable.destroy(); }
  _write(chunk: any, encoding: string, callback: any) {
    return this._writable._write(chunk, encoding, callback);
  }
  _read(size: number) {
    const chunk = this._readable.read();
    if (chunk) this.push(chunk);
    else this._readable.once('readable', () => this._read(size));
  }
}

export async function command(config: FileSystemConfig): Promise<NodeJS.ReadWriteStream> {
  Logging.info(`Creating ProxyCommand connection for ${config.name}`);
  validateConfig(config);
  const proxy = config.proxy!;
  if (proxy.type !== 'command') throw new Error(`Expected config.proxy.type' to be 'command'`);
  Logging.debug('\tcommand: ' + proxy.command);
  const proc = spawn(proxy.command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
  if (proc.killed) throw new Error(`ProxyCommand process died with exit code ${proc.exitCode}`);
  if (!proc.pid) throw new Error(`ProxyCommand process did not spawn, possible exit code: ${proc.exitCode}`);
  return new ReadWriteWrapper(proc.stdout, proc.stdin);
}
