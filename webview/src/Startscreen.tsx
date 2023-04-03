import { ConfigLocation, FileSystemConfig, formatConfigLocation, groupByGroup, groupByLocation } from 'common/fileSystemConfig';
import * as React from 'react';
import ConfigList from './ConfigList';
import { receivedData } from './data/actions';
import { connect, pickProperties } from './redux';
import type { IStartScreenState } from './view';
import { openNewConfig, openStartScreen } from './view/actions';
import { API } from './vscode';

interface StateProps {
    configs: FileSystemConfig[];
    groupBy: string;
}
interface DispatchProps {
    refresh(reload?: boolean): void;
    changeGroupBy(current: string): void;
    add(): void;
}
class Startscreen extends React.Component<StateProps & DispatchProps> {
    public componentDidMount() {
        this.props.refresh();
    }
    public render() {
        const grouped = (this.props.groupBy === 'group' ? groupByGroup : groupByLocation)(this.props.configs);
        grouped.sort((a, b) => a[0] > b[0] ? 1 : -1);
        const nextGroupBy = this.props.groupBy === 'group' ? 'location' : 'group';
        return <div className="Homescreen">
            <h2>Configurations</h2>
            <button onClick={this.reload}>Reload</button>
            <button onClick={this.props.add}>Add</button>
            <button onClick={this.changeGroupBy}>Sort by {nextGroupBy}</button>
            {grouped.map(([loc, configs]) => this.createGroup(loc, configs))}
        </div>;
    }
    public createGroup(group: string | ConfigLocation, configs: FileSystemConfig[]) {
        const title = this.props.groupBy === 'group' ? group : formatConfigLocation(group as ConfigLocation);
        return <div key={group}>
            <h3>{title}</h3>
            <ConfigList configs={configs} />
        </div>;
    }
    protected reload = () => this.props.refresh(true);
    protected changeGroupBy = () => this.props.changeGroupBy(this.props.groupBy);
}

export default connect(Startscreen)<StateProps, DispatchProps>(
    state => ({
        ...pickProperties(state.data, 'configs'),
        ...pickProperties(state.view as IStartScreenState, 'groupBy'),
    }),
    dispatch => ({
        add: () => dispatch(openNewConfig()),
        changeGroupBy: (current: string) => dispatch(openStartScreen(current === 'group' ? 'location' : 'group')),
        refresh: (reload?: boolean) => {
            dispatch(receivedData([], []));
            API.postMessage({ type: 'requestData', reload });
        },
    }),
);
