import * as React from 'react';
import { connect } from 'src/redux';
import { FileSystemConfig } from 'src/types/fileSystemConfig';
import { openConfigEditor } from 'src/view/actions';
import './index.css';

interface StateProps {
    list: FileSystemConfig[];
}
interface DispatchProps {
    editConfig(config: FileSystemConfig): void;
}
interface OwnProps {
    configs?: FileSystemConfig[];
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
        const onClick = () => this.props.editConfig(config);
        return <li key={config.name} onClick={onClick}>{config.label || config.name}</li>;
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
