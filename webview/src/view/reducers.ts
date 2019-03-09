import { Action, ActionType } from './actions';
import { DEFAULT_STATE, IConfigEditorState, INewConfigState, IState } from './state';

export function reducer(state = DEFAULT_STATE, action: Action): IState {
  switch (action.type) {
    // Startscreen
    case ActionType.OPEN_STARTSCREEN:
      return { ...state, view: 'startscreen' };
    // New Config
    case ActionType.OPEN_NEWCONFIG: {
      const { locations, name } = action;
      return { ...state, view: 'newconfig', name, locations, location: locations[0] };
    }
    case ActionType.NEWCONFIG_SETNAME:
      return { ...state as INewConfigState, name: action.name };
    case ActionType.NEWCONFIG_SETLOCATION:
      return { ...state as INewConfigState, location: action.location };
    // ConfigEditor
    case ActionType.OPEN_CONFIGEDITOR: {
      const { config } = action;
      return { ...state, view: 'configeditor', oldConfig: config, newConfig: config };
    }
    case ActionType.CONFIGEDITOR_SETNEWCONFIG:
      return { ...state as IConfigEditorState, newConfig: action.config };
    case ActionType.CONFIGEDITOR_SETSTATUSMESSAGE:
      return { ...state as IConfigEditorState, statusMessage: action.message };
  }
  return state;
}

export default reducer;
