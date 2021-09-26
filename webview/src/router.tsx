import ConfigEditor from './ConfigEditor';
import ConfigLocator from './ConfigLocator';
import NewConfig from './NewConfig';
import { connect, State } from './redux';
import Startscreen from './Startscreen';

interface StateProps {
    view: State['view']['view'];
}
function Router(props: StateProps) {
    switch (props.view) {
        case 'configeditor':
            return <ConfigEditor />;
        case 'configlocator':
            return <ConfigLocator />;
        case 'newconfig':
            return <NewConfig />;
        case 'startscreen':
        default:
            return <Startscreen />;
    }
}

export default connect(Router)<StateProps>(state => ({ view: state.view.view }));
