import { FieldDropdownWithInput } from '../FieldTypes/dropdownwithinput';
import { connect } from '../redux';
import { getGroups } from '../types/fileSystemConfig';

export interface StateProps {
    values: string[];
}

export default connect(FieldDropdownWithInput)<StateProps>(
    state => ({ values: getGroups(state.data.configs).sort() }),
);
