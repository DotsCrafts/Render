import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// ux-render's Tailwind theme first; the chrome's own (unlayered) rules below
// win for the surrounding browser chrome, leaving the panel on the dark theme.
import '@render/ux-render/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('renderer: #root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
