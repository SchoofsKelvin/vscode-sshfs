
import type { Store } from 'redux';
import { addListener } from '../vscode';
import * as actions from './actions';

export { reducer } from './reducers';
export * from './state';
export { actions };

export function initStore(store: Store) {
  addListener((msg) => store.dispatch(actions.receivedData(msg.configs, msg.locations)), 'responseData');
}
