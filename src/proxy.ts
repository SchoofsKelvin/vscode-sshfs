
import * as dns from 'dns';
import { SocksClient } from 'socks';

import { FileSystemConfig } from './manager';
import { toPromise } from './toPromise';

export async function socks(config: FileSystemConfig): Promise<FileSystemConfig> {
  if (!config.proxy) throw new Error(`Missing field 'config.proxy'`);
  if (!config.proxy.host) throw new Error(`Missing field 'config.proxy.host'`);
  if (!config.proxy.port) throw new Error(`Missing field 'config.proxy.port'`);
  if (!config.proxy.type) throw new Error(`Missing field 'config.proxy.type'`);
  if (config.proxy.type !== 'socks4' && config.proxy.type !== 'socks5') {
    throw new Error(`Expected config.proxy.type' to be 'socks4 or 'socks5'`);
  }
  try {
    const ipaddress = (await toPromise<string[]>(cb => dns.resolve(config.proxy!.host, cb)))[0];
    if (!ipaddress) throw new Error(`Couldn't resolve '${config.proxy.host}'`);
    const con = await SocksClient.createConnection({
      command: 'connect',
      destination: {
        host: config.host!,
        port: config.port!,
      },
      proxy: {
        ipaddress,
        port: config.proxy.port,
        type: config.proxy.type === 'socks4' ? 4 : 5,
      },
    });
    config.sock = con.socket as NodeJS.ReadableStream;
    return config;
  } catch (e) {
    throw new Error(`Error while connecting to the the proxy: ${e.message}`);
  }
}
