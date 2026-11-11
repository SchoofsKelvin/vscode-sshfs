import { FileSystemConfig, formatConfigLocation, isSshConfigLocation } from 'common/fileSystemConfig';
import * as React from 'react';
import { FieldGroup } from '../FieldTypes/group';
import { connect, pickProperties } from '../redux';
import type { IConfigEditorState } from '../view';
import { configEditorSetNewConfig, configEditorSetStatusMessage, openStartScreen } from '../view/actions';
import { API, deleteConfig, saveConfig } from '../vscode';
import * as Fields from './fields';
import './index.css';

interface StateProps {
    newConfig: FileSystemConfig;
    oldConfig: FileSystemConfig;
    statusMessage?: string;
}
interface DispatchProps {
    setNewConfig(config: FileSystemConfig): void;
    confirm(config: FileSystemConfig, oldName: string): void;
    delete(config: FileSystemConfig): void;
    cancel(): void;
}
class ConfigEditor extends React.Component<StateProps & DispatchProps> {
    public render() {
        const { newConfig, oldConfig } = this.props;
        if (isSshConfigLocation(oldConfig._location)) return this.renderSshConfigHost(oldConfig);
        return <FieldGroup>
            <div className="ConfigEditor">
                <div className="header">
                    <button className="cancel" onClick={this.props.cancel}>Back</button>
                    <div className="title">
                        <h3>{oldConfig.label || oldConfig.name}</h3>
                        <h4>{formatConfigLocation(oldConfig._location!)}</h4>
                    </div>
                </div>
                {Fields.FIELDS.map(f => f(newConfig, this.onChange, this.onChangeMultiple)).filter(e => e)}
                <div className="divider" />
                <FieldGroup.Consumer>{group => <React.Fragment>
                    <button className="cancel" onClick={this.props.cancel}>Cancel</button>
                    <button className="delete" onClick={this.props.delete.bind(this, newConfig)}>Delete</button>
                    <button className="confirm" onClick={this.props.confirm.bind(this, newConfig, oldConfig.name)} disabled={!!group!.getErrors().length}>Save</button>
                </React.Fragment>}</FieldGroup.Consumer>
            </div>
        </FieldGroup>;
    }
    /** Hosts from an OpenSSH config file (e.g. ~/.ssh/config) are read-only: that file is the only place they're configured */
    protected renderSshConfigHost(config: FileSystemConfig) {
        const address = `${config.username ? `${config.username}@` : ''}${config.host}${config.port ? `:${config.port}` : ''}`;
        const details: [string, string | undefined][] = [
            ['Address', address],
            ['ProxyJump', config.proxyJump],
            ['ProxyCommand', config.proxyCommand],
            ['RemoteCommand', config.remoteCommand],
            ['Identity files', config.identityFiles?.join(', ')],
            ['Agent', config.agent],
            ['Root', config.root],
        ];
        const openFile = () => API.postMessage({ type: 'openConfigSource', config });
        return <div className="ConfigEditor">
            <div className="header">
                <button className="cancel" onClick={this.props.cancel}>Back</button>
                <div className="title">
                    <h3>{config.label || config.name}</h3>
                    <h4>{formatConfigLocation(config._location!)}</h4>
                </div>
            </div>
            <p>
                This host is read directly from your OpenSSH config file every time it is needed.
                Nothing about it is stored by SSH FS, so it can only be changed by editing that file.
            </p>
            <table>
                <tbody>
                    {details.filter(([, value]) => value).map(([key, value]) => <tr key={key}>
                        <td><b>{key}</b></td>
                        <td>{value}</td>
                    </tr>)}
                </tbody>
            </table>
            <p>
                To customize SSH FS specific options (e.g. the root folder), create a regular SSH FS
                configuration with the same name and enable its "Merge" option.
            </p>
            <div className="divider" />
            <button className="cancel" onClick={this.props.cancel}>Back</button>
            <button className="confirm" onClick={openFile}>Open the OpenSSH config file</button>
        </div>;
    }
    protected onChange: Fields.FSCChanged = (key, value) => {
        console.log(`Changed field '${key}' to: ${value}`);
        this.props.setNewConfig({ ...this.props.newConfig, [key]: value });
    };
    protected onChangeMultiple: Fields.FSCChangedMultiple = (newConfig) => {
        console.log('Overwriting config fields:', newConfig);
        this.props.setNewConfig({ ...this.props.newConfig, ...newConfig });
    };
}

interface SubState { view: IConfigEditorState };
export default connect(ConfigEditor)<StateProps, DispatchProps, SubState>(
    (state) => pickProperties(state.view, 'newConfig', 'oldConfig', 'statusMessage'),
    (dispatch) => ({
        setNewConfig(config) {
            dispatch(configEditorSetNewConfig(config));
        },
        async confirm(config, oldName) {
            dispatch(configEditorSetStatusMessage('Saving...'));
            try {
                await saveConfig(config, oldName);
            } catch (e) {
                dispatch(configEditorSetStatusMessage(`Error while saving: ${e}`));
                return;
            }
            dispatch(openStartScreen());
        },
        async delete(config) {
            dispatch(configEditorSetStatusMessage('Deleting...'));
            try {
                await deleteConfig(config);
            } catch (e) {
                dispatch(configEditorSetStatusMessage(`Error while deleting: ${e}`));
                return;
            }
            dispatch(openStartScreen());
        },
        cancel() {
            dispatch(openStartScreen());
        },
    })
);
