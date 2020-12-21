import * as React from 'react';
import { connect as realConnect } from 'react-redux';
import { combineReducers, createStore, Dispatch } from 'redux';
import * as data from './data';
import * as view from './view';
import { API } from './vscode';

const reducers = combineReducers({
  data: data.reducer,
  view: view.reducer,
});

export interface State {
  data: data.IState;
  view: view.IState;
}

export type Action = data.actions.Action | view.actions.Action;

export const DEFAULT_STATE: State = {
  data: data.DEFAULT_STATE,
  view: view.DEFAULT_STATE,
};

export const STORE = createStore(reducers, API.getState() || DEFAULT_STATE, undefined);
data.initStore(STORE);
view.initStore(STORE);

const oldDispatch = STORE.dispatch.bind(STORE);
STORE.dispatch = (action) => {
  console.log('STORE.dispatch', action);
  oldDispatch(action);
  return action;
};

STORE.subscribe(() => API.setState(STORE.getState()));

API.postMessage({ type: 'navigated', view: STORE.getState().view.view });

// Makes debugging easier (and this is inside our WebView context anyway)
(window as any).STORE = STORE;

type GetComponentProps<C> = C extends React.ComponentClass<infer P, any> ? P : (C extends React.FunctionComponent<infer P2> ? P2 : {});
type GetComponentState<C> = C extends React.ComponentClass<any, infer S> ? S : {};

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

type OwnProps<C extends (React.ComponentClass<any> | React.FunctionComponent<any>), P> = Omit<GetComponentProps<C>, keyof P>;

interface ConnectReturn<C extends (React.ComponentClass<any> | React.FunctionComponent<any>)> {
  <TStateProps, TState = State>(
    stateToProps: (state: TState, ownProps: OwnProps<C, TStateProps>) => TStateProps
  ): React.ComponentClass<Omit<GetComponentProps<C>, keyof TStateProps>, GetComponentState<C>>;
  <TStateProps, TDispatchProps, TState = State>(
    stateToProps: (state: TState, ownProps: Omit<GetComponentProps<C>, keyof (TStateProps & TDispatchProps)>) => TStateProps,
    dispatchToProps: (dispatch: Dispatch<Action>, ownProps: Omit<GetComponentProps<C>, keyof TStateProps & TDispatchProps>) => TDispatchProps,
  ): React.ComponentClass<Omit<GetComponentProps<C>, keyof (TStateProps & TDispatchProps)>, GetComponentState<C>>;
}

export function connect<TComponent extends (React.ComponentClass<any> | React.FunctionComponent<any>)>(component: TComponent): ConnectReturn<TComponent> {
  return (stateToProps: any, dispatchToProps?: any) => realConnect(stateToProps, dispatchToProps)(component) as any;
}

export function pickProperties<T, K extends keyof T>(obj: T, ...keys: K[]): Pick<T, K> {
  const res: Pick<T, K> = {} as any;
  for (const key of keys) {
    res[key] = obj[key];
  }
  return res;
}
