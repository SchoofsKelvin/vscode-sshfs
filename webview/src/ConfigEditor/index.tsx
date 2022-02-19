import { FileSystemConfig, formatConfigLocation } from 'common/fileSystemConfig';
import * as React from 'react';
import { FieldGroup } from '../FieldTypes/group';
import { connect, pickProperties } from '../redux';
import type { IConfigEditorState } from '../view';
import { configEditorSetNewConfig, configEditorSetStatusMessage, openStartScreen } from '../view/actions';
import { deleteConfig, saveConfig } from '../vscode';
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
