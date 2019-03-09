import * as React from 'react';
import ConfigEditor from './ConfigEditor';
import Homescreen from './Homescreen';
import NewConfig from './NewConfig';
import { connect, State } from './redux';

interface StateProps {
    view: State['view']['view'];
}
function Router(props: StateProps) {
    switch (props.view) {
        case 'configeditor':
            return <ConfigEditor />;
        case 'newconfig':
            return <NewConfig />;
        case 'startscreen':
        default:
            return <Homescreen />;
    }
}

export default connect(Router)<StateProps>(state => ({ view: state.view.view }));
