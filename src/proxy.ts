
import * as dns from 'dns';
import { request } from 'http';
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
  if (!config.proxy.host) throw new Error(`Missing field 'config.proxy.host'`);
  if (!config.proxy.port) throw new Error(`Missing field 'config.proxy.port'`);
  if (!config.proxy.type) throw new Error(`Missing field 'config.proxy.type'`);
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
