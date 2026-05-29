import { FormEvent, useState } from 'react';
import { Bot, Eye, EyeOff, Github, Globe2, LockKeyhole, Server, ShieldCheck } from 'lucide-react';
import { languageOptions, useI18n } from '../i18n';
import { BrandIcon } from './BrandIcon';

interface LoginPageProps {
  loading: boolean;
  error: string;
  onLogin: (username: string, password: string) => Promise<void>;
}

export function LoginPage({ loading, error, onLogin }: LoginPageProps) {
  const { language, setLanguage, t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(username.trim(), password);
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel-header">
          <div className="login-brand">
            <div className="brand-mark app-brand-mark">
              <BrandIcon />
            </div>
            <div>
              <strong>CoLiPas</strong>
              <span>{t('login.subtitle')}</span>
            </div>
          </div>

          <a
            className="login-github-link"
            href="https://github.com/nmklio/CoLiPas"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
          >
            <Github size={17} />
            <span>GitHub</span>
          </a>
        </div>

        <div className="login-copy">
          <p>{t('login.eyebrow')}</p>
          <h1 id="login-title">{t('login.title')}</h1>
          <span>{t('login.description')}</span>
        </div>

        <div className="login-feature-grid" aria-label={t('login.features')}>
          <span><Server size={16} /> {t('login.featureAssets')}</span>
          <span><Bot size={16} /> {t('login.featureAi')}</span>
          <span><ShieldCheck size={16} /> {t('login.featureAudit')}</span>
        </div>
      </section>

      <section className="login-card" aria-labelledby="login-form-title">
        <div className="login-card-head">
          <div>
            <p>{t('login.secureAccess')}</p>
            <h2 id="login-form-title">{t('login.formTitle')}</h2>
          </div>
          <label className="language-switcher">
            <Globe2 size={14} />
            <select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>
              {languageOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span>{t('login.username')}</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder={t('login.usernamePlaceholder')}
              required
            />
          </label>

          <label className="login-field">
            <span>{t('login.password')}</span>
            <div className="password-input">
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder={t('login.passwordPlaceholder')}
                required
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {error && <div className="login-error" role="alert">{error}</div>}

          <button type="submit" className="login-submit" disabled={loading}>
            <LockKeyhole size={17} />
            {loading ? t('login.signingIn') : t('login.submit')}
          </button>
        </form>
      </section>
    </main>
  );
}
