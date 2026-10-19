import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { readSharedEvidenceToken, SharedEvidencePage } from './app/SharedEvidencePage';
import { applyTheme } from './app/theme';
import { LanguageProvider } from './i18n';
import './styles/tokens.css';
import './styles/global.css';
import './styles/theme-dark.css';

// Resolve the colour theme before the first paint of the application.
applyTheme();

const sharedEvidenceToken = readSharedEvidenceToken(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      {sharedEvidenceToken ? <SharedEvidencePage token={sharedEvidenceToken} /> : <App />}
    </LanguageProvider>
  </StrictMode>,
);
