
import type { FileSystemConfig } from 'common/fileSystemConfig';
import * as dns from 'dns';
import { request } from 'http';
import { SocksClient } from 'socks';
import { Logging } from './logging';
import { toPromise, validatePort } from './utils';

async function resolveHostname(hostname: string): Promise<string> {
  return toPromise<string>(cb => dns.lookup(hostname, cb)).then((ip) => {
    Logging.debug`Resolved hostname "${hostname}" to: ${ip}`;
    return ip;
  });
}

function validateConfig(config: FileSystemConfig) {
  if (!config.proxy) throw new Error(`Missing field 'config.proxy'`);
  if (!config.proxy.type) throw new Error(`Missing field 'config.proxy.type'`);
  if (!config.proxy.host) throw new Error(`Missing field 'config.proxy.host'`);
  if (!config.proxy.port) throw new Error(`Missing field 'config.proxy.port'`);
  config.proxy.port = validatePort(config.proxy.port);
}

export async function socks(config: FileSystemConfig): Promise<NodeJS.ReadableStream> {
  Logging.info`Creating socks proxy connection for ${config.name}`;
  validateConfig(config);
  if (config.proxy!.type !== 'socks4' && config.proxy!.type !== 'socks5') {
    throw new Error(`Expected 'config.proxy.type' to be 'socks4' or 'socks5'`);
  }
  try {
    const ipaddress = (await resolveHostname(config.proxy!.host));
    if (!ipaddress) throw new Error(`Couldn't resolve '${config.proxy!.host}'`);
    Logging.debug`\tConnecting to ${config.host}:${config.port} over ${config.proxy!.type} proxy at ${ipaddress}:${config.proxy!.port}`;
    const con = await SocksClient.createConnection({
      command: 'connect',
      destination: {
        host: config.host!,
        port: config.port!,
      },
      proxy: {
        ipaddress,
        port: config.proxy!.port,
        type: config.proxy!.type === 'socks4' ? 4 : 5,
      },
    });
    return con.socket as NodeJS.ReadableStream;
  } catch (e) {
    throw new Error(`Error while connecting to the the proxy: ${e.message}`);
  }
}

export function http(config: FileSystemConfig): Promise<NodeJS.ReadableStream> {
  Logging.info`Creating http proxy connection for ${config.name}`;
  validateConfig(config);
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    if (config.proxy!.type !== 'http') {
      reject(new Error(`Expected config.proxy.type' to be 'http'`));
    }
    try {
      Logging.debug`\tConnecting to ${config.host}:${config.port} over http proxy at ${config.proxy!.host}:${config.proxy!.port}`;
      const req = request({
        port: config.proxy!.port,
        hostname: config.proxy!.host,
        method: 'CONNECT',
        path: `${config.host}:${config.port}`,
      });
      req.end();
      req.on('connect', (res, socket) => {
        resolve(socket as NodeJS.ReadableStream);
      });
    } catch (e) {
      reject(new Error(`Error while connecting to the the proxy: ${e.message}`));
    }
  });
}
