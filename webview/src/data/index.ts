
import { createStore } from 'redux';
import { addListener } from 'src/vscode';
import * as actions from './actions';
import reducer from './reducers';

export const STORE = createStore(reducer)

addListener((msg) => STORE.dispatch(actions.receivedConfigs(msg.configs)), 'responseData');
