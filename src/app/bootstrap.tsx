/**
 * Bootstrap — M02 FlashFinger renderer entry point.
 *
 * Renders the shared React app into the #root container.
 * See DESIGN_SPECIFICATION §1.3/§7.1.
 */

import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('FlashFinger: #root element not found in DOM');
}

const root = createRoot(rootEl);
root.render(<App />);
