import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DemoApp from './DemoApp';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');
createRoot(root).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
