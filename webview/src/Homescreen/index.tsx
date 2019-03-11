import * as React from 'react';
import ConfigList from 'src/ConfigList';
import { receivedData } from 'src/data/actions';
import { connect } from 'src/redux';
import { ConfigLocation, FileSystemConfig, formatConfigLocation, groupByLocation } from 'src/types/fileSystemConfig';
import { openNewConfig } from 'src/view/actions';
import { API } from 'src/vscode';
import './index.css';

interface StateProps {
    configs: FileSystemConfig[];
    locations: ConfigLocation[];
}
interface DispatchProps {
    refresh(): void;
    add(locations: ConfigLocation[]): void;
}
class Homescreen extends React.Component<StateProps & DispatchProps> {
    public componentDidMount() {
        this.props.refresh();
    }
    public render() {
        const grouped = groupByLocation(this.props.configs);
        grouped.sort();
        return <div className="Homescreen">
            <h2>Configurations</h2>
            <button onClick={this.props.refresh}>Refresh</button>
            <button onClick={this.add}>Add</button>
            {grouped.map(([loc, configs]) => this.createGroup(loc, configs))}
        </div>;
    }
    public createGroup(location: ConfigLocation, configs: FileSystemConfig[]) {
        return <div key={location}>
            <h3>{formatConfigLocation(location)}</h3>
            <ConfigList configs={configs} />
        </div>;
    }
    public add = () => this.props.add(this.props.locations);
}

export default connect(Homescreen)<StateProps, DispatchProps>(
    state => ({ configs: state.data.configs, locations: state.data.locations }),
    dispatch => ({
        add: locations => dispatch(openNewConfig(locations)),
        refresh: () => (dispatch(receivedData([], [])), API.postMessage({ type: 'requestData' })),
    }),
);
