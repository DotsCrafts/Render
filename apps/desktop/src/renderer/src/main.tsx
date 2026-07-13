import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// ux-render's Tailwind theme first; the chrome's own (unlayered) rules below
// win for the surrounding browser chrome, leaving the panel on the dark theme.
import '@render/ux-render/styles.css';
import './styles.css';

// macOS gets the real Liquid Glass treatment: the window is created with
// under-window vibrancy + hiddenInset traffic lights (main/index.ts), so the
// chrome may go translucent (`glass`) and the tab strip insets for the lights
// (`mac`). Elsewhere the window is solid/framed and both classes stay off.
if (/mac/i.test(navigator.platform)) {
  document.documentElement.classList.add('glass', 'mac');
}

const root = document.getElementById('root');
if (!root) throw new Error('renderer: #root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
