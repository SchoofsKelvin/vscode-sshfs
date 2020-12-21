import * as React from 'react';
import { FieldDropdown } from '../FieldTypes/dropdown';
import { FieldDropdownWithInput } from '../FieldTypes/dropdownwithinput';
import { FieldNumber } from '../FieldTypes/number';
import { FieldString } from '../FieldTypes/string';
import { FileSystemConfig } from '../types/fileSystemConfig';
import { FieldFactory, FSCChanged, FSCChangedMultiple } from './fields';

export function proxy(config: FileSystemConfig, onChange: FSCChanged<'proxy'>): React.ReactElement {
    const onChangeHost = (host: string) => onChange('proxy', { ...config.proxy!, host });
    const onChangePort = (port: number) => onChange('proxy', { ...config.proxy!, port });
    console.log('Current config:', config);
    return <React.Fragment>
        <p>{new Date().toString()}</p>
        <FieldString label="Proxy Host" value={config.proxy!.host} onChange={onChangeHost}
            description="Hostname or IP address of the proxy." />
        <FieldNumber label="Proxy Port" value={config.proxy!.port} onChange={onChangePort}
            description="Hostname or IP address of the proxy." />
    </React.Fragment>;
}

export function hop(config: FileSystemConfig, onChange: FSCChanged<'hop'>): React.ReactElement {
    const callback = (newValue?: string) => onChange('hop', newValue);
    const description = 'Use another configuration as proxy, using a SSH tunnel through the targeted config to the actual remote system';
    const values = ['TO', ' DO'];
    return <FieldDropdownWithInput key="hop" label="Hop" {...{ values, description }} value={config.hop} onChange={callback} optional={true} />;
}

const ProxyTypeToString = {
    http: 'HTTP',
    socks4: 'SOCKS 4',
    socks5: 'SOCKS 5',
} as const;
const ProxyStringToType = {
    'HTTP': 'http',
    'SOCKS 4': 'socks4',
    'SOCKS 5': 'socks5',
    'SSH Hop': 'hop',
} as const;
type ProxyStrings = keyof typeof ProxyStringToType;

export function merged(config: FileSystemConfig, onChange: FSCChanged, onChangeMultiple: FSCChangedMultiple): React.ReactElement | null {
    function callback(newValue?: ProxyStrings) {
        // Fields starting with _ don't get saved to file
        // We use it here so we know when to display the hop stuff
        if (!newValue) {
            return onChangeMultiple({
                ['_hop' as any]: undefined,
                hop: undefined,
                proxy: undefined,
            });
        }
        const newType = ProxyStringToType[newValue];
        if (newType === 'hop') {
            return onChangeMultiple({
                ['_hop' as any]: true,
                proxy: undefined,
            });
        }
        return onChangeMultiple({
            ['_hop' as any]: undefined,
            hop: undefined,
            proxy: {
                host: '',
                port: 22,
                ...config.proxy,
                type: newType,
            }
        });
    }
    const description = 'The type of proxy to use when connecting to the remote system';
    const values: ProxyStrings[] = ['SSH Hop', 'SOCKS 4', 'SOCKS 5', 'HTTP'];
    const showHop = config.hop || (config as any)._hop;
    const type = config.proxy && config.proxy.type;
    const value = showHop ? 'SSH Hop' : (type && ProxyTypeToString[type]);
    return <React.Fragment key="proxy">
        <FieldDropdown<ProxyStrings | undefined> key="proxy" label="Proxy" {...{ value, values, description }} onChange={callback} optional={true} />
        {showHop && hop(config, onChange)}
        {config.proxy && proxy(config, onChange)}
    </React.Fragment>;
}

export const PROXY_FIELD: FieldFactory = merged;