import { Action, ActionType } from './actions';
import { DEFAULT_STATE, IState } from './state';

export function reducer(state = DEFAULT_STATE, action: Action): IState {
  switch (action.type) {
    case ActionType.RECEIVED_CONFIGS: {
      return { ...state, configs: action.configs };
    }
  }
  throw new Error(`Unhandled action type: ${action.type}`);
}

export default reducer;
