import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { readSharedEvidenceToken, SharedEvidencePage } from './app/SharedEvidencePage';
import { LanguageProvider } from './i18n';
import './styles/global.css';

const sharedEvidenceToken = readSharedEvidenceToken(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      {sharedEvidenceToken ? <SharedEvidencePage token={sharedEvidenceToken} /> : <App />}
    </LanguageProvider>
  </StrictMode>,
);
