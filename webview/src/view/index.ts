
import type { Store } from 'redux';
import { addListener } from '../vscode';
import * as actions from './actions';

export { reducer } from './reducers';
export * from './state';
export { actions };

export function initStore(store: Store) {
  addListener((msg) => {
    const { navigation } = msg;
    switch (navigation.type) {
      case 'newconfig':
        return store.dispatch(actions.openNewConfig());
      case 'editconfig': {
        let { config } = navigation;
        if (Array.isArray(config)) {
          if (config.length !== 1) {
            return store.dispatch(actions.openConfigLocator(config, config[0].name));
          }
          config = config[0];
        }
        return store.dispatch(actions.openConfigEditor(config));
      }
    }
  }, 'navigate');
}
