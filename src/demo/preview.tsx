import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import '../styles.css';
import '../components/widgets/formControls.css';
import '../projectTags.css';
import '../components/ui/styles.css';

// The workshop must always use the adapter's existing browser branches.
if ('__TAURI_INTERNALS__' in window) throw new Error('The UI workshop requires browser mode');
const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
