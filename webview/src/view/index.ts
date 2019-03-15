
import { Store } from 'redux';
import { addListener, API } from 'src/vscode';
import * as actions from './actions';

export { reducer } from './reducers';
export { actions }
export * from './state';

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
    API.postMessage({ type: 'navigated', navigation });
  }, 'navigate');
}
