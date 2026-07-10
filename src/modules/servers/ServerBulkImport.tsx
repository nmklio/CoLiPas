import { useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, FileJson2, FileUp, ShieldCheck, Table2, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { bulkImportServers, type BulkImportServersResponse } from '../../services/apiClient';
import type { ServerNode } from '../../types';
import {
  buildServerBulkImportPreview,
  buildServerBulkImportTemplate,
  serverBulkImportLimit,
  serverBulkImportMaxBytes,
  type ServerBulkImportGlobalIssue,
  type ServerBulkImportRowIssue,
} from './serverBulkImportParser';

interface ServerBulkImportProps {
  open: boolean;
  existingServers: ServerNode[];
  onClose: () => void;
  onImported: () => Promise<void> | void;
}

const previewRowLimit = 12;

export function ServerBulkImport({ open, existingServers, onClose, onImported }: ServerBulkImportProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState('');
  const [fileIssue, setFileIssue] = useState<ServerBulkImportGlobalIssue | null>(null);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BulkImportServersResponse | null>(null);
  const [message, setMessage] = useState('');
  const preview = useMemo(() => buildServerBulkImportPreview(source, existingServers), [source, existingServers]);
  const globalIssues = fileIssue ? [fileIssue] : preview.globalIssues;
  const visibleRows = preview.rows.slice(0, previewRowLimit);

  if (!open) {
    return null;
  }

  async function importPreview() {
    if (preview.importable.length === 0 || globalIssues.length > 0 || importing) {
      return;
    }
    setImporting(true);
    setMessage('');
    setResult(null);
    try {
      const response = await bulkImportServers(preview.importable);
      setResult(response);
      setMessage(t('servers.bulkImport.success', {
        imported: response.summary.imported,
        skipped: response.summary.skipped,
      }));
      await onImported();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('servers.bulkImport.failed'));
    } finally {
      setImporting(false);
    }
  }

  async function readImportFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setFileName(file.name);
    setResult(null);
    setMessage('');
    if (file.size > serverBulkImportMaxBytes) {
      setFileIssue('too-large');
      setSource('');
      return;
    }
    setFileIssue(null);
    setSource(await file.text());
  }

  function downloadTemplate() {
    const blob = new Blob([buildServerBulkImportTemplate()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'colipas-server-import-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function resetImport() {
    setSource('');
    setFileIssue(null);
    setFileName('');
    setResult(null);
    setMessage('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  return (
    <section
      id="server-bulk-import-panel"
      className="server-bulk-import"
      data-server-bulk-import="true"
      aria-labelledby="server-bulk-import-title"
    >
      <header className="server-bulk-import-head">
        <div className="server-bulk-import-icon" aria-hidden="true">
          <FileUp size={21} />
        </div>
        <div>
          <span>{t('servers.bulkImport.eyebrow')}</span>
          <h3 id="server-bulk-import-title">{t('servers.bulkImport.title')}</h3>
          <p>{t('servers.bulkImport.detail', { count: serverBulkImportLimit })}</p>
        </div>
        <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <div className="server-bulk-import-safety">
        <ShieldCheck size={17} aria-hidden="true" />
        <div>
          <strong>{t('servers.bulkImport.safetyTitle')}</strong>
          <span>{t('servers.bulkImport.safetyDetail')}</span>
        </div>
      </div>

      <div className="server-bulk-import-source">
        <div className="server-bulk-import-source-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            hidden
            data-server-bulk-import-file="true"
            onChange={(event) => {
              void readImportFile(event.target.files?.[0]);
            }}
          />
          <button type="button" className="tool-button primary" onClick={() => fileInputRef.current?.click()}>
            <FileUp size={15} />
            {t('servers.bulkImport.chooseFile')}
          </button>
          <button type="button" className="tool-button" data-server-bulk-import-template="true" onClick={downloadTemplate}>
            <Download size={15} />
            {t('servers.bulkImport.template')}
          </button>
          {(source || fileIssue) && (
            <button type="button" className="tool-button" onClick={resetImport}>
              <X size={15} />
              {t('servers.bulkImport.clear')}
            </button>
          )}
          {fileName && <span>{fileName}</span>}
        </div>
        <label>
          <span>{t('servers.bulkImport.pasteLabel')}</span>
          <textarea
            value={source}
            data-server-bulk-import-source="true"
            spellCheck={false}
            placeholder={t('servers.bulkImport.pastePlaceholder')}
            onChange={(event) => {
              setSource(event.target.value);
              setFileIssue(null);
              setResult(null);
              setMessage('');
            }}
          />
        </label>
      </div>

      {globalIssues.length > 0 && (source.trim() || fileIssue) && (
        <div className="server-bulk-import-global-error" data-server-bulk-import-error="true">
          <TriangleAlert size={17} aria-hidden="true" />
          <strong>{globalIssues.map((issue) => t(`servers.bulkImport.issue.${issue}`)).join(' / ')}</strong>
        </div>
      )}

      {preview.rows.length > 0 && globalIssues.length === 0 && (
        <>
          <div className="server-bulk-import-summary" data-server-bulk-import-summary="true">
            <article>
              <Table2 size={15} />
              <span>{t('servers.bulkImport.total')}</span>
              <strong>{preview.summary.total}</strong>
            </article>
            <article className="valid">
              <CheckCircle2 size={15} />
              <span>{t('servers.bulkImport.valid')}</span>
              <strong>{preview.summary.valid}</strong>
            </article>
            <article className={preview.summary.invalid > 0 ? 'invalid' : ''}>
              <TriangleAlert size={15} />
              <span>{t('servers.bulkImport.invalid')}</span>
              <strong>{preview.summary.invalid}</strong>
            </article>
            <article className={preview.summary.duplicates > 0 ? 'duplicate' : ''}>
              <FileJson2 size={15} />
              <span>{t('servers.bulkImport.duplicate')}</span>
              <strong>{preview.summary.duplicates}</strong>
            </article>
          </div>

          <div className="server-bulk-import-table-wrap">
            <table className="server-bulk-import-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('servers.name')}</th>
                  <th>{t('common.provider')}</th>
                  <th>{t('servers.publicIp')}</th>
                  <th>{t('common.region')}</th>
                  <th>{t('servers.tags')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={`${row.rowNumber}-${row.name}-${row.publicIp}`} data-server-bulk-import-row={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td><strong>{row.name || '—'}</strong></td>
                    <td>{row.provider || '—'}</td>
                    <td><code>{row.publicIp || '—'}</code></td>
                    <td>{row.region || t('servers.bulkImport.autoFallback')}</td>
                    <td>{row.tags.join(' / ') || '—'}</td>
                    <td>
                      <span className={`server-bulk-import-row-state ${row.issues.length === 0 ? 'valid' : 'invalid'}`}>
                        {row.issues.length === 0
                          ? t('servers.bulkImport.rowReady')
                          : formatRowIssues(row.issues, t)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > visibleRows.length && (
            <p className="server-bulk-import-more">{t('servers.bulkImport.moreRows', { count: preview.rows.length - visibleRows.length })}</p>
          )}
        </>
      )}

      <footer className="server-bulk-import-footer">
        <div aria-live="polite">
          {result ? <CheckCircle2 size={16} /> : <ShieldCheck size={16} />}
          <span>{message || t('servers.bulkImport.footer')}</span>
        </div>
        <button
          type="button"
          className="tool-button primary"
          data-server-bulk-import-submit="true"
          disabled={preview.importable.length === 0 || globalIssues.length > 0 || importing}
          onClick={() => {
            void importPreview();
          }}
        >
          <FileUp size={15} />
          {importing
            ? t('servers.bulkImport.importing')
            : t('servers.bulkImport.submit', { count: preview.importable.length })}
        </button>
      </footer>
    </section>
  );
}

function formatRowIssues(
  issues: ServerBulkImportRowIssue[],
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  return issues.map((issue) => t(`servers.bulkImport.rowIssue.${issue}`)).join(' / ');
}
