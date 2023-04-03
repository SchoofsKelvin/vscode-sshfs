import { FileSystemConfig, formatConfigLocation } from 'common/fileSystemConfig';
import * as React from 'react';
import ConfigList from './ConfigList';
import { connect, pickProperties } from './redux';
import type { IConfigLocatorState } from './view';

function displayName(config: FileSystemConfig) {
    return formatConfigLocation(config._location);
}

interface StateProps {
    configs: FileSystemConfig[];
    name: string;
}
class ConfigLocator extends React.Component<StateProps> {
    public render() {
        const { configs, name } = this.props;
        return <div className="ConfigLocator">
            <h2>Locations of {name}</h2>
            <ConfigList configs={configs} displayName={displayName} />
        </div>;
    }
}

interface SubState { view: IConfigLocatorState }
export default connect(ConfigLocator)<StateProps, SubState>(
    state => pickProperties(state.view, 'configs', 'name'),
);
