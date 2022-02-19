import type { FileSystemConfig } from 'common/fileSystemConfig';
import * as React from 'react';
import { FieldConfig } from '../FieldTypes/config';
import { FieldDropdown } from '../FieldTypes/dropdown';
import { FieldNumber } from '../FieldTypes/number';
import { FieldString } from '../FieldTypes/string';
import type { FieldFactory, FSCChanged, FSCChangedMultiple } from './fields';

function hostAndPort(config: FileSystemConfig, onChange: FSCChanged<'proxy'>): React.ReactElement {
    const onChangeHost = (host: string) => onChange('proxy', { ...config.proxy!, host });
    const onChangePort = (port: number) => onChange('proxy', { ...config.proxy!, port });
    console.log('Current config:', config);
    return <React.Fragment>
        <FieldString label="Proxy Host" value={config.proxy!.host} onChange={onChangeHost}
            description="Hostname or IP address of the proxy." />
        <FieldNumber label="Proxy Port" value={config.proxy!.port} onChange={onChangePort}
            description="Hostname or IP address of the proxy." />
    </React.Fragment>;
}

function hop(config: FileSystemConfig, onChange: FSCChanged<'hop'>): React.ReactElement {
    const callback = (newValue?: FileSystemConfig) => onChange('hop', newValue?.name);
    const description = 'Use another configuration as proxy, using a SSH tunnel through the targeted config to the actual remote system';
    return <FieldConfig key="hop" label="Hop" onChange={callback} value={config.hop} description={description} />;
}

enum ProxyType { http, socks4, socks5, hop }
const ProxyTypeNames: Record<ProxyType, string> = {
    [ProxyType.http]: 'HTTP',
    [ProxyType.socks4]: 'SOCKS 4',
    [ProxyType.socks5]: 'SOCKS 5',
    [ProxyType.hop]: 'SSH Hop',
};

function Merged(props: { config: FileSystemConfig, onChange: FSCChanged, onChangeMultiple: FSCChangedMultiple }): React.ReactElement | null {
    const { config, onChange, onChangeMultiple } = props;
    const [showHop, setShowHop] = React.useState(!!config.hop);
    function callback(newValue?: ProxyType) {
        if (!newValue) {
            setShowHop(false);
            return onChangeMultiple({
                hop: undefined,
                proxy: undefined,
            });
        }
        if (newValue === ProxyType.hop) {
            setShowHop(true);
            return onChangeMultiple({ proxy: undefined });
        }
        setShowHop(false);
        return onChangeMultiple({
            hop: undefined,
            proxy: {
                host: '',
                port: 22,
                ...config.proxy,
                type: ProxyType[newValue] as any,
            }
        });
    }
    const description = 'The type of proxy to use when connecting to the remote system';
    const values: ProxyType[] = [ProxyType.hop, ProxyType.socks4, ProxyType.socks5, ProxyType.http];
    const type = config.proxy?.type;
    const value = (config.hop || showHop) ? ProxyType.hop : (type && ProxyType[type]);
    return <React.Fragment key="proxy">
        <FieldDropdown key="proxy" label="Proxy" {...{ value, values, description } as const} displayName={i => ProxyTypeNames[i!]} onChange={callback} optional />
        {(config.hop || showHop) && hop(config, onChange)}
        {config.proxy && hostAndPort(config, onChange)}
    </React.Fragment>;
}

export const PROXY_FIELD: FieldFactory = (config, onChange, onChangeMultiple) =>
    <Merged config={config} onChange={onChange} onChangeMultiple={onChangeMultiple} />;
