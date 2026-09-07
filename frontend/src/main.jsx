import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Order matters: tokens define the variables, base consumes them for the reset,
// components build on both.
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
