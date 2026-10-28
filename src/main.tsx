import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeSettings } from './settingsStorage';
import './styles.css';
import './projectTags.css';

// Disable the WebView2 default context menu (Back/Refresh/Save as/Print) —
// a desktop panel does not need it; hotkeys (Ctrl+C/V and devtools) keep working.
document.addEventListener('contextmenu', (e) => e.preventDefault());

const root = document.getElementById('root');

if (!root) throw new Error('Root element #root not found');

void initializeSettings().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
