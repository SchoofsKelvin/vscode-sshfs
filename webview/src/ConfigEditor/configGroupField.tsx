import { FieldDropdownWithInput } from 'src/FieldTypes/dropdownwithinput';
import { connect } from 'src/redux';
import { getGroups } from 'src/types/fileSystemConfig';

export interface StateProps {
    values: string[];
}

export default connect(FieldDropdownWithInput)<StateProps>(
    state => ({ values: getGroups(state.data.configs).sort() }),
);
