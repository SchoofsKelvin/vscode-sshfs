
import { Store } from 'redux';
import * as actions from './actions';

export { reducer } from './reducers';
export { actions }
export * from './state';

export function initStore(store: Store) {
  // Nothing really
}
