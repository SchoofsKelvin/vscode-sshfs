import * as ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import './index.css';
import { STORE } from './redux';
import Router from './router';
import { API } from './vscode';

ReactDOM.render(
  <Provider store={STORE}>
    <div className="App">
      <Router />
    </div>
  </Provider>,
  document.getElementById('root') as HTMLElement
);

API.postMessage({ type: 'requestData' });
