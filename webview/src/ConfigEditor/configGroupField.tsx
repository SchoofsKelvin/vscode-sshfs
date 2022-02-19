import { getGroups } from 'common/fileSystemConfig';
import { FieldDropdownWithInput } from '../FieldTypes/dropdownwithinput';
import { connect } from '../redux';

export interface StateProps {
    values: string[];
}

export default connect(FieldDropdownWithInput)<StateProps>(
    state => ({ values: getGroups(state.data.configs).sort() }),
);
