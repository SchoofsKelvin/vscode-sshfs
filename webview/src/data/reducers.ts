import { Action, ActionType } from './actions';
import { DEFAULT_STATE, IState } from './state';

export function reducer(state = DEFAULT_STATE, action: Action): IState {
  console.log('data reducer', action);
  switch (action.type) {
    case ActionType.RECEIVED_DATA: {
      return { ...state, configs: action.configs, locations: action.locations };
    }
  }
  return state;
}

export default reducer;
