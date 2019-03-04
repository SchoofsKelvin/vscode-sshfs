import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import { STORE } from './data';
import './index.css';
import { addListener, API } from './vscode';

class TestThingy extends React.Component<any, { msg: string }> {
  constructor(props: { msg: string }) {
    super(props);
    this.state = { msg: 'Loading...' };
  }
  public componentDidMount() {
    console.log('componentDidMount');
    addListener(msg => {
      this.setState({
        msg: JSON.stringify(msg.configs),
      });
    }, 'responseData');
    API.postMessage({ type: 'requestData' });
  }
  public render() {
    return <div><p>{this.state.msg}</p></div>;
  }
}

const TIME = new Date();

ReactDOM.render(
  <Provider store={STORE}>
    <div className="App">
      <header className="App-header">
        <h1 className="App-title">Welcome to React I guess? {TIME}</h1>
      </header>
      <p className="App-intro">
        To get started, edit <code>src/App.tsx</code> and save to reload.
    </p>
      <TestThingy />
      <p>OK</p>
    </div>
  </Provider>,
  document.getElementById('root') as HTMLElement
);
