import * as React from 'react';
import { connect } from '../redux';

function nop(...args: any) {
    return;
}

{
    // Check if type stuff is right for our connect thing
    // The wrapper components should act as if it has all its props, except the ones
    // that get provided by the stateToProps/dispatchToProps passed to connect
    interface S { s: 123 };
    interface D { d: 456 };
    interface P { p: 789 };
    class Test extends React.Component<S & D & P> { }
    const TestC1 = connect(Test)<S>(state => ({ s: 123 }));
    nop(<TestC1 d={456} p={789} />);
    const TestC2 = connect(Test)<S, D>(state => ({ s: 123 }), dispatch => ({ d: 456 }));
    nop(<TestC2 p={789} />);
    const TestC3 = connect(Test)<S, { state: 123 }>(state => ({ s: 123 }));
    nop(<TestC3 d={456} p={789} />);
    const TestC4 = connect(Test)<S, D, { state: 123 }>(state => ({ s: 123 }), dispatch => ({ d: 456 }));
    nop(<TestC4 p={789} />);
}
