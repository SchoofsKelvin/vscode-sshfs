import { API } from '../vscode';
import { Action, ActionType } from './actions';
import { DEFAULT_STATE, IConfigEditorState, INewConfigState, IStartScreenState, IState } from './state';

function setView(state: IState): IState {
  API.postMessage({ type: 'navigated', view: state.view });
  return state;
}

export function reducer(state = DEFAULT_STATE, action: Action): IState {
  switch (action.type) {
    // Startscreen
    case ActionType.OPEN_STARTSCREEN: {
      const groupBy = action.groupBy || (state as IStartScreenState).groupBy || 'group';
      return setView({ ...state, view: 'startscreen', groupBy });
    }
    // New Config
    case ActionType.OPEN_NEWCONFIG: {
      const { name } = action;
      return setView({ ...state, view: 'newconfig', name, location: undefined });
    }
    case ActionType.NEWCONFIG_SETNAME:
      return { ...state as INewConfigState, name: action.name };
    case ActionType.NEWCONFIG_SETLOCATION:
      return { ...state as INewConfigState, location: action.location };
    // ConfigEditor
    case ActionType.OPEN_CONFIGEDITOR: {
      const { config } = action;
      return setView({ ...state, view: 'configeditor', oldConfig: config, newConfig: config });
    }
    case ActionType.OPEN_CONFIGLOCATOR: {
      const { name, configs } = action;
      return setView({ ...state, view: 'configlocator', name, configs });
    }
    case ActionType.CONFIGEDITOR_SETNEWCONFIG:
      return { ...state as IConfigEditorState, newConfig: action.config };
    case ActionType.CONFIGEDITOR_SETSTATUSMESSAGE:
      return { ...state as IConfigEditorState, statusMessage: action.message };
  }
  return state;
}

export default reducer;
