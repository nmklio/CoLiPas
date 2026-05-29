<div align="center">

# CoLiPas

### セルフホスト可能なマルチクラウドサーバー運用コンソール

</div>

## 言語

[中文文档](README_CN.md) | [English Docs](README.md) | [日本語ドキュメント](README_JP.md)

## 概要

CoLiPas は、実運用を想定したクラウドサーバー管理パネルです。サーバー台帳、グローバル監視マップ、SSH ターミナル、AI 運用アシスタント、ワークフロー自動化、カスタム API テスト、セキュリティ監査、リリース検証を、ログインで保護された 1 つのコンソールにまとめます。

構成は React + TypeScript + Express + SQLite です。1 つの Node.js 本番サービスが `/api/*` とビルド済みフロントエンドを配信します。ランタイムデータは既定で `.data` に保存され、SSH 認証情報は `CREDENTIAL_ENCRYPTION_KEY` で暗号化されます。

このリポジトリには、ソースコード、サニタイズ済みサンプル、デプロイスクリプトだけを置く方針です。実サーバーの IP、パスワード、API Key、SSH 秘密鍵、`.env`、`.data`、ランタイム DB、ログ、ユーザーデータはコミットしないでください。

## 主な機能

| モジュール | 内容 |
| --- | --- |
| マルチクラウド台帳 | クラウドアカウント概要、カスタムプロバイダー、ライフサイクル、リージョン/OS 推定、リソース更新、マップ集約。 |
| サーバー接続 | 手動登録、台帳専用モード、模擬 SSH、パスワード/秘密鍵 SSH 検証、診断、電源操作。 |
| ブラウザー SSH | xterm 風の対話型端末、リアルタイム出力、閉じた時のバックエンドセッション破棄、`Ctrl+C`、コピー、クリア。 |
| AI 運用 | OpenAI 互換 API、モデル取得、ストリーミング会話、複数ターン文脈、キャッシュ、強制更新、接続テスト。 |
| 運用自動化 | 資産同期、ヘルスチェック、SSH コマンド、再起動/停止などを実行前チェック付きで実行。 |
| カスタム API | サーバー側の安全なプロキシでクラウド API を検証し、プライベートネットワークや危険なヘッダーを遮断。 |
| セキュリティ監査 | ログイン、API、SSH、運用タスク、修復操作、リリース証跡を監査ログに保存。 |

## クイックスタート

```bash
git clone https://github.com/nmklio/CoLiPas.git
cd CoLiPas
npm install
cp .env.example .env
npm test
npm start
```

起動後に開きます。

```text
http://127.0.0.1:8080/
```

よく使うスクリプト:

```bash
npm run build        # フロントエンドとバックエンドをビルド
npm run smoke        # 起動済みサービスに対するスモークテスト
npm run perf         # ブラウザー性能チェック
npm test             # 本番相当の完全な検証
npm start            # 本番サービスを起動
```

## ランタイム設定

`.env.example` から `.env` を作成し、公開前に必ず既定値を置き換えてください。

| 変数 | 用途 |
| --- | --- |
| `PORT` | 本番 HTTP ポート。例では `8080` を使います。 |
| `CORS_ORIGIN` | API を利用できるブラウザーのオリジン。 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初期管理者アカウント。公開前に必ず変更してください。 |
| `SESSION_SECRET` | セッション Cookie 用の長いランダム値。 |
| `COLIPAS_DATA_DIR` | ランタイムデータディレクトリ。既定は `.data`。 |
| `COLIPAS_DB_PATH` | SQLite DB パス。既定はデータディレクトリ内です。 |
| `CREDENTIAL_ENCRYPTION_KEY` | 保存済み SSH 認証情報を暗号化する長いキー。 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 任意の OpenAI 互換プロバイダー設定。 |
| `CUSTOM_API_ALLOWED_HOSTS` | カスタム API テストで許可するホスト一覧。 |
| `RELEASE_VERIFY_TOKEN` | 任意のリリース検証 API 用 Bearer Token。 |

## 本番デプロイ

最も簡単な本番導入方法は、対話式 Linux インストーラーです。インストール先、公開 URL、管理者ユーザー名、デプロイ方式、初期パスワードを確認し、コード取得、非公開 `.env` の作成、サービス起動、ヘルスチェックまで実行します。

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo bash
```

推奨値:

| 項目 | 推奨値 |
| --- | --- |
| Install directory | `/opt/colipas` |
| Git branch | `master` |
| Public URL or domain | HTTPS ドメイン、例 `https://colipas.example.com` |
| Admin username | `admin` または運用アカウント名 |
| Deployment mode | 通常は `Docker Compose`、ホストの systemd 管理が必要なら `Native systemd` |
| Initial admin password | 強いパスワードを入力、または空欄で自動生成 |

インストーラーは秘密情報をサーバー上にだけ保存します。`/opt/colipas/.env` が既に存在する場合、現在の管理者パスワード、DB パス、SSH 暗号化キー、AI 設定、その他のランタイム設定を保持します。

無人インストールでは環境変数で同じ値を渡せます。

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='ChangeThisStrongPassword123' \
  COLIPAS_DEPLOY_MODE=docker \
  COLIPAS_ASSUME_YES=1 \
  bash
```

主なオプション: `COLIPAS_APP_DIR`、`COLIPAS_BRANCH`、`COLIPAS_ADMIN_USERNAME`、`COLIPAS_DEPLOY_MODE=docker|native`、`COLIPAS_NON_INTERACTIVE=1`、`COLIPAS_ASSUME_YES=1`。

### 手動 Docker Compose

各コマンドを自分で管理したい場合だけ使います。

```bash
git clone https://github.com/nmklio/CoLiPas.git
cd CoLiPas
cp .env.example .env
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
```

`docker-compose.yml` は `/app/.data` にボリュームをマウントします。SQLite データ、監査ログ、暗号化済み SSH メタデータ、アカウント設定はコンテナ再作成後も保持されます。

### 公開 Docker イメージ

`master` に push されるたびに、GitHub Container Registry へ公開イメージを発行します。

```bash
docker pull ghcr.io/nmklio/colipas:latest
docker volume create colipas-data
docker run -d --name colipas --restart unless-stopped \
  --env-file .env \
  -p 8080:8080 \
  -v colipas-data:/app/.data \
  ghcr.io/nmklio/colipas:latest
curl -fsS http://127.0.0.1:8080/api/health
```

利用できるタグは `latest`、`master`、`v1.0.0` のようなリリースタグ、`sha-ab12cd3` のような短いコミットタグです。

### 手動 Linux + systemd

journald、systemd、ホスト統合を使いたい場合の方式です。

```bash
sudo useradd --system --home /opt/colipas --shell /usr/sbin/nologin colipas
sudo mkdir -p /opt/colipas
sudo chown -R colipas:colipas /opt/colipas
sudo -u colipas git clone https://github.com/nmklio/CoLiPas.git /opt/colipas
cd /opt/colipas
sudo -u colipas cp .env.example .env
sudo -u colipas npm ci
sudo -u colipas npm test
sudo cp deploy/colipas.service /etc/systemd/system/colipas.service
sudo systemctl daemon-reload
sudo systemctl enable --now colipas
curl -fsS http://127.0.0.1:8080/api/health
```

## 管理者パスワードを忘れた場合

CoLiPas は平文パスワードを保存せず、`scrypt` ハッシュだけを保存します。忘れた場合は復元ではなくリセットします。

ネイティブ Linux:

```bash
cd /opt/colipas
sudo -u colipas env COLIPAS_RESET_PASSWORD='NewStrongPassword123' npm run reset:admin
sudo systemctl restart colipas
```

Docker Compose:

```bash
docker compose exec -e COLIPAS_RESET_PASSWORD='NewStrongPassword123' colipas npm run reset:admin
docker compose restart colipas
```

このスクリプトは管理者アカウントだけを更新します。サーバー、SSH 認証情報、監査ログ、AI キャッシュ、カスタム API 設定、その他のランタイムデータは削除しません。

## セキュリティモデル

- ヘルスチェックと認証以外の運用 API はログインが必要です。
- セッション Cookie は HTTP-only で、パスワード変更時に他のセッションを失効させます。
- SSH コマンドの監査要約はマスクされ、長さも制限されます。
- SSH 認証情報は `CREDENTIAL_ENCRYPTION_KEY` で暗号化されます。
- カスタム API プロキシはプライベート IP、リンクローカル、危険なヘッダー、機密ネットワークへのリダイレクトを遮断します。
- リリース検証、診断エクスポート、監査レポートはキー、秘密鍵、実ランタイムデータを漏らさない設計です。

## 検証

コミットや公開前に推奨されるコマンド:

```bash
npm test
npm audit --omit=dev --audit-level=high
node scripts/secret-scan.mjs
```

完全なテストは、ビルド、一時的な本番サービス、API スモーク、ブラウザー検証、性能チェック、並行処理チェック、管理者パスワードリセット検証を実行します。
