import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, ExternalLink, Eye, LockKeyhole, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { getLocale, useI18n } from '../i18n';
import type { PublicReleaseEvidenceShare } from '../types';
import { BrandIcon } from './BrandIcon';

interface SharedEvidencePageProps {
  token: string;
}

type SharedEvidenceCopy = {
  eyebrow: string;
  title: string;
  lead: string;
  loading: string;
  unavailable: string;
  expired: string;
  sharedAt: string;
  expiresAt: string;
  score: string;
  checks: string;
  risks: string;
  gate: string;
  nextAction: string;
  highlights: string;
  disclosure: string;
  stateReady: string;
  stateReview: string;
  stateBlocked: string;
  gatePass: string;
  gateBlocked: string;
  gateDisabled: string;
  passed: string;
  attention: string;
  back: string;
};

const copyByLanguage: Record<string, SharedEvidenceCopy> = {
  zh: {
    eyebrow: '仅供审阅',
    title: '上线证据快照',
    lead: '此链接只展示创建时固化的脱敏汇总，不会连接服务器或读取实时数据。',
    loading: '正在加载已分享的证据…',
    unavailable: '该证据链接不可用、已撤销或已过期。',
    expired: '链接过期时间',
    sharedAt: '创建时间',
    expiresAt: '有效至',
    score: '上线评分',
    checks: '检查通过',
    risks: '风险项',
    gate: '发布门禁',
    nextAction: '建议下一步',
    highlights: '检查概览',
    disclosure: '分享边界',
    stateReady: '可发布',
    stateReview: '需要复核',
    stateBlocked: '已阻断',
    gatePass: '允许发布',
    gateBlocked: '暂不允许发布',
    gateDisabled: '门禁未启用',
    passed: '已通过',
    attention: '需关注',
    back: '返回 CoLiPas',
  },
  en: {
    eyebrow: 'Review-only',
    title: 'Release evidence snapshot',
    lead: 'This fixed, sanitized summary never opens servers or reads live runtime data.',
    loading: 'Loading shared evidence…',
    unavailable: 'This evidence link is unavailable, revoked, or expired.',
    expired: 'Link expiry',
    sharedAt: 'Created',
    expiresAt: 'Available until',
    score: 'Readiness score',
    checks: 'Checks passed',
    risks: 'Risk items',
    gate: 'Release gate',
    nextAction: 'Recommended next step',
    highlights: 'Check overview',
    disclosure: 'Share boundary',
    stateReady: 'Ready',
    stateReview: 'Needs review',
    stateBlocked: 'Blocked',
    gatePass: 'Publish allowed',
    gateBlocked: 'Publish blocked',
    gateDisabled: 'Gate disabled',
    passed: 'Passed',
    attention: 'Needs attention',
    back: 'Return to CoLiPas',
  },
  ja: {
    eyebrow: '閲覧専用',
    title: 'リリース証跡スナップショット',
    lead: 'この固定・匿名化サマリーはサーバーに接続せず、リアルタイムデータも読み取りません。',
    loading: '共有証跡を読み込み中…',
    unavailable: 'この証跡リンクは利用できない、失効、または取り消されています。',
    expired: 'リンクの有効期限',
    sharedAt: '作成時刻',
    expiresAt: '有効期限',
    score: '準備スコア',
    checks: '合格チェック',
    risks: 'リスク項目',
    gate: 'リリースゲート',
    nextAction: '推奨される次の対応',
    highlights: 'チェック概要',
    disclosure: '共有範囲',
    stateReady: '公開可能',
    stateReview: '要確認',
    stateBlocked: 'ブロック中',
    gatePass: '公開可能',
    gateBlocked: '公開を停止',
    gateDisabled: 'ゲート無効',
    passed: '合格',
    attention: '要確認',
    back: 'CoLiPas に戻る',
  },
};

export function SharedEvidencePage({ token }: SharedEvidencePageProps) {
  const { language } = useI18n();
  const copy = copyByLanguage[language] ?? copyByLanguage.zh;
  const locale = getLocale(language);
  const [evidence, setEvidence] = useState<PublicReleaseEvidenceShare | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setEvidence(null);
    setError('');
    fetch(`/api/public/release-evidence/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('shared-evidence-unavailable');
        }
        return response.json() as Promise<PublicReleaseEvidenceShare>;
      })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setEvidence(payload);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(copy.unavailable);
        }
      });
    return () => controller.abort();
  }, [copy.unavailable, token]);

  const statusLabel = useMemo(() => {
    if (evidence?.status === 'ready') {
      return copy.stateReady;
    }
    if (evidence?.status === 'blocked') {
      return copy.stateBlocked;
    }
    return copy.stateReview;
  }, [copy, evidence?.status]);

  return (
    <main className="shared-evidence-shell">
      <section className="shared-evidence-card" data-public-release-evidence="true">
        <header className="shared-evidence-header">
          <a className="shared-evidence-brand" href="/" aria-label="CoLiPas">
            <span className="brand-mark app-brand-mark"><BrandIcon /></span>
            <span>CoLiPas</span>
          </a>
          <span className="shared-evidence-lock"><LockKeyhole size={14} /> {copy.eyebrow}</span>
        </header>

        {!evidence && !error ? (
          <div className="shared-evidence-state loading"><Clock3 size={20} /><p>{copy.loading}</p></div>
        ) : null}

        {error ? (
          <div className="shared-evidence-state error">
            <ShieldAlert size={24} />
            <h1>{copy.title}</h1>
            <p>{error}</p>
            <a href="/" className="shared-evidence-return"><ExternalLink size={15} /> {copy.back}</a>
          </div>
        ) : null}

        {evidence ? (
          <div className="shared-evidence-content">
            <div className={`shared-evidence-hero ${evidence.status}`}>
              <div>
                <span>{copy.eyebrow}</span>
                <h1>{copy.title}</h1>
                <p>{copy.lead}</p>
              </div>
              <div className="shared-evidence-score">
                <small>{copy.score}</small>
                <strong>{evidence.score}</strong>
                <span>{statusLabel}</span>
              </div>
            </div>

            <div className="shared-evidence-meta">
              <span><Clock3 size={14} /> {copy.sharedAt}: {formatTime(evidence.sharedAt, locale)}</span>
              <span><Eye size={14} /> {copy.expiresAt}: {formatTime(evidence.expiresAt, locale)}</span>
            </div>

            <div className="shared-evidence-kpis">
              <article>
                <small>{copy.checks}</small>
                <strong>{evidence.summary.passed}/{evidence.summary.totalChecks}</strong>
              </article>
              <article className={evidence.summary.failures > 0 ? 'fail' : evidence.summary.warnings > 0 ? 'warn' : 'ok'}>
                <small>{copy.risks}</small>
                <strong>{evidence.summary.failures + evidence.summary.warnings}</strong>
              </article>
              <article className={evidence.gate.allowedToRelease ? 'ok' : 'fail'}>
                <small>{copy.gate}</small>
                <strong>{evidence.gate.status === 'disabled' ? copy.gateDisabled : evidence.gate.allowedToRelease ? copy.gatePass : copy.gateBlocked}</strong>
              </article>
            </div>

            <section className="shared-evidence-section">
              <span>{copy.nextAction}</span>
              <p>{evidence.nextBestAction}</p>
            </section>

            <section className="shared-evidence-section">
              <span>{copy.highlights}</span>
              <div className="shared-evidence-highlights">
                {evidence.highlights.map((highlight) => (
                  <article key={highlight.id} className={highlight.passed ? 'ok' : highlight.severity === 'fail' ? 'fail' : 'warn'}>
                    {highlight.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                    <span>{highlight.label}</span>
                    <small>{highlight.passed ? copy.passed : copy.attention}</small>
                  </article>
                ))}
              </div>
            </section>

            <section className="shared-evidence-disclosure">
              <ShieldCheck size={18} />
              <div>
                <strong>{copy.disclosure}</strong>
                <p>{evidence.disclosure}</p>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function formatTime(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function readSharedEvidenceToken(pathname: string) {
  const match = pathname.match(/^\/share\/release\/([A-Za-z0-9_-]{40,96})\/?$/);
  return match?.[1] ?? '';
}
