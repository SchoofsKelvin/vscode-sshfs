import type { FileSystemConfig } from 'common/fileSystemConfig';
import * as React from 'react';
import { connect } from '../redux';
import { openConfigEditor } from '../view/actions';
import './index.css';

interface StateProps {
    list: FileSystemConfig[];
}
interface DispatchProps {
    editConfig(config: FileSystemConfig): void;
}
interface OwnProps {
    configs?: FileSystemConfig[];
    displayName?(config: FileSystemConfig): string | undefined;
}
class ConfigList extends React.Component<StateProps & DispatchProps & OwnProps> {
    public render() {
        const { list } = this.props;
        if (!list.length) return <p>No configurations found</p>;
        return <div className="ConfigList">
            <ul>
                {list.map(this.editConfigClickHandler, this)}
            </ul>
        </div>;
    }
    public editConfigClickHandler(config: FileSystemConfig) {
        const { displayName } = this.props;
        const name = displayName?.(config) || config.label || config.name;
        const onClick = () => this.props.editConfig(config);
        return <li key={config.name} onClick={onClick}>{name}</li>;
    }
}

export default connect(ConfigList)<StateProps, DispatchProps>(
    (state, props: OwnProps) => ({ list: props.configs || state.data.configs }),
    dispatch => ({
        editConfig(config: FileSystemConfig) {
            dispatch(openConfigEditor(config));
        },
    })
);
