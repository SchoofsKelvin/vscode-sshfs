
import * as Winreg from 'winreg';
import { Logging } from './logging';
import { toPromise } from './toPromise';

const winreg = new Winreg({
  hive: Winreg.HKCU,
  key: `\\Software\\SimonTatham\\PuTTY\\Sessions\\`,
});

export type NumberAsBoolean = 0 | 1;
export interface PuttySession {
  [key: string]: string | number | undefined;
  // General settings
  name: string;
  hostname: string;
  protocol: string;
  portnumber: number;
  username?: string;
  usernamefromenvironment: NumberAsBoolean;
  tryagent: NumberAsBoolean;
  publickeyfile?: string;
  // Proxy settings
  proxyhost?: string;
  proxyport: number;
  proxylocalhost: NumberAsBoolean;
  proxymethod: number; // Key of ['None', 'SOCKS 4', 'SOCKS 5', 'HTTP', 'Telnet', 'Local'] // Only checked first 3
}

function valueFromItem(item: Winreg.RegistryItem) {
  switch (item.type) {
    case 'REG_DWORD':
      return parseInt(item.value, 16);
    case 'REG_SZ':
      return item.value;
  }
  throw new Error(`Unknown RegistryItem type: '${item.type}'`);
}

export async function getSessions() {
  Logging.info(`Fetching PuTTY sessions from registry`);
  const values = await toPromise<Winreg.Registry[]>(cb => winreg.keys(cb));
  const sessions: PuttySession[] = [];
  await Promise.all(values.map(regSession => (async (res, rej) => {
    const name = decodeURIComponent(regSession.key.substr(winreg.key.length));
    const props = await toPromise<Winreg.RegistryItem[]>(cb => regSession.values(cb));
    const properties: { [key: string]: string | number } = {};
    props.forEach(prop => properties[prop.name.toLowerCase()] = valueFromItem(prop));
    sessions.push({ name, ...(properties as any) });
  })()));
  Logging.debug(`\tFound ${sessions.length} sessions:`);
  sessions.forEach(s => Logging.debug(`\t${JSON.stringify(s)}`));
  return sessions;
}

export async function getSession(name?: string, host?: string, username?: string, nameOnly = false): Promise<PuttySession | null> {
  const sessions = await getSessions();
  if (name) {
    name = name.toLowerCase();
    const session = sessions.find(s => s.name.toLowerCase() === name) || null;
    if (nameOnly || session) return session;
  }
  if (!host) return null;
  host = host.toLowerCase();
  const hosts = sessions.filter(s => s.hostname && s.hostname.toLowerCase() === host);
  if (!username) return hosts[0] || null;
  username = username.toLowerCase();
  return hosts.find(s => !s.username || s.username.toLowerCase() === username) || null;
}
