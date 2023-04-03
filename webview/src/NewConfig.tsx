import { ConfigLocation, formatConfigLocation, invalidConfigName } from 'common/fileSystemConfig';
import * as React from 'react';
import { FieldDropdown } from './FieldTypes/dropdown';
import { FieldGroup } from './FieldTypes/group';
import { FieldString } from './FieldTypes/string';
import { connect, pickProperties, State } from './redux';
import type { INewConfigState } from './view';
import { newConfigSetLocation, newConfigSetName, openConfigEditor, openStartScreen } from './view/actions';
import { createConfig } from './vscode';

const LOCATION_DESCRIPTION = 'The file or Settings file to add the new configuration to';

interface StateProps {
    location: ConfigLocation;
    locations: ConfigLocation[];
    name: string;
}
interface DispatchProps {
    setName(name: string): void;
    setLocation(location: ConfigLocation): void;
    cancel(): void;
    confirm(name: string, location: ConfigLocation): void;
}
class NewConfig extends React.Component<StateProps & DispatchProps> {
    public render() {
        const { locations, name, location, setName, setLocation, cancel } = this.props;
        locations.sort();
        return <FieldGroup>
            <div className="NewConfig">
                <h2>Create new configuration</h2>
                <FieldString
                    label="Name"
                    description="Name of the config. Accepted characters: [0-9a-z_.+-@]"
                    value={name}
                    validator={invalidConfigName}
                    onChange={setName}
                />
                <FieldDropdown<ConfigLocation>
                    label="Location"
                    description={LOCATION_DESCRIPTION}
                    value={location}
                    values={locations}
                    onChange={setLocation}
                    displayName={formatConfigLocation} />
                <FieldGroup.Consumer>{group => <React.Fragment>
                    <button className="cancel" onClick={cancel}>Cancel</button>
                    <button className="confirm" onClick={this.confirm} disabled={!!group!.getErrors().length}>Save</button>
                </React.Fragment>}</FieldGroup.Consumer>
            </div>
        </FieldGroup>;
    }
    public confirm = () => this.props.confirm(this.props.name, this.props.location);
}

interface SubState extends State { view: INewConfigState }
export default connect(NewConfig)<StateProps, DispatchProps, SubState>(
    (state) => ({
        ...pickProperties(state.view, 'name'),
        ...pickProperties(state.data, 'locations'),
        location: state.view.location || state.data.locations[0],
    }),
    (dispatch) => ({
        cancel: () => dispatch(openStartScreen()),
        setLocation: loc => dispatch(newConfigSetLocation(loc)),
        setName: name => dispatch(newConfigSetName(name)),
        async confirm(name, loc) {
            try {
                const config = await createConfig(name, loc);
                dispatch(openConfigEditor(config));
            } catch (e) {
                console.error(`Unexpected error while creating a config '${name}' in location: ${loc}`);
                console.error(e);
            }
        }
    }),
);
