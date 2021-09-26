import * as React from 'react';
import { FieldDropdown } from '../FieldTypes/dropdown';
import { FieldNumber } from '../FieldTypes/number';
import { FieldString } from '../FieldTypes/string';
import { connect } from '../redux';
import { FileSystemConfig } from '../types/fileSystemConfig';
import type { FieldFactory, FSCChanged, FSCChangedMultiple } from './fields';

function proxy(config: FileSystemConfig, onChange: FSCChanged<'proxy'>): React.ReactElement {
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

interface HopFieldProps {
    config: FileSystemConfig;
    configs: [name: string, label: string][];
    onChange: FSCChanged<'hop'>;
}
const HopField = connect(({ config, configs, onChange }: HopFieldProps) => {
    const callback = (newValue?: [string, string]) => onChange('hop', newValue?.[0]);
    const description = 'Use another configuration as proxy, using a SSH tunnel through the targeted config to the actual remote system';
    const displayName = (item: [string, string]) => item[1];
    const value = config.hop ? [config.hop, configs.find(c => c[0] === config.hop)?.[1] || config.hop] as const : undefined;
    return <FieldDropdown key="hop" label="Hop"  {...{ value, values: configs, description, displayName } as const} onChange={callback} optional />;
})<Pick<HopFieldProps, 'configs'>>(state => {
    const pairs = new Map<string, string>();
    for (const { name, label } of state.data.configs) {
        pairs.set(name, label || name);
    }
    return { configs: Array.from(pairs) };
});

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

function merged(config: FileSystemConfig, onChange: FSCChanged, onChangeMultiple: FSCChangedMultiple): React.ReactElement | null {
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
        <FieldDropdown key="proxy" label="Proxy" {...{ value, values, description } as const} onChange={callback} optional />
        {showHop && <HopField config={config} onChange={onChange} />}
        {config.proxy && proxy(config, onChange)}
    </React.Fragment>;
}

export const PROXY_FIELD: FieldFactory = merged;