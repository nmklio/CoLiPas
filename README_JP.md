<div align="center">

# CoLiPas クラウドサーバー管理パネル

### セルフホスト可能なマルチクラウドサーバー運用コンソール

</div>

## 言語

[中文文档](README_CN.md) | [English Docs](README.md) | [日本語ドキュメント](README_JP.md)

## 概要

CoLiPas クラウドサーバー管理パネルは、実運用を想定したクラウドサーバー管理パネルです。サーバー台帳、グローバル監視マップ、SSH ターミナル、AI 運用アシスタント、ワークフロー自動化、カスタム API テスト、セキュリティ監査、リリース検証を、ログインで保護された 1 つのコンソールにまとめます。

構成は React + TypeScript + Express + SQLite です。1 つの Node.js 本番サービスが `/api/*` とビルド済みフロントエンドを配信します。ランタイムデータは既定で `.data` に保存され、SSH 認証情報は `CREDENTIAL_ENCRYPTION_KEY` で暗号化されます。

このリポジトリには、ソースコード、サニタイズ済みサンプル、デプロイスクリプトだけを置く方針です。実サーバーの IP、パスワード、API Key、SSH 秘密鍵、`.env`、`.data`、ランタイム DB、ログ、ユーザーデータはコミットしないでください。

## 主な機能

| モジュール | 内容 |
| --- | --- |
| メンテナンス時間枠 | 再起動、停止、高影響 SSH コマンドの時間枠を保存し、時間プリセットと実行前確認で対象ごとのカバー状況を表示します。 |
| マルチクラウド台帳 | クラウドアカウント概要、カスタムプロバイダー、ライフサイクル、リージョン/OS 推定、リソース更新、マップ集約。 |
| サーバー接続 | 手動登録、台帳専用モード、模擬 SSH、パスワード/秘密鍵 SSH 検証、診断、電源操作。 |
| 安全な一括インポート | CSV / JSON のファイル選択または貼り付け内容を事前検証し、表計算ソフトの数式注入を防ぐローカル検証レポートを保存できます。2 MB・500 行の上限、名前/IP 重複のスキップ、SQLite トランザクション書き込みを行い、パスワード、秘密鍵、Token、API Key、SSH 認証情報フィールドは拒否されます。 |
| ブラウザー SSH | xterm 風の対話型端末、WebSocket のリアルタイム出力と互換ストリームへのフォールバック、永続化される操作 / 集中 / 診断ワークスペース、閉じた時のバックエンドセッション破棄、`Ctrl+C`、可視化された切断復旧、コマンドを再送しない手動再接続、コピー、クリア。 |
| 資産ビュー | よく使うキーワード、プロバイダー、状態、リージョン、ヘルスの絞り込みを最大 8 件までブラウザーだけに保存し、調査範囲をすぐ復元できます。絞り込み値や資産情報はアップロードされません。 |
| コンテキスト公開チェック | Overview では 6 項目の完全な公開チェックを表示し、それ以外の作業スペースとパフォーマンスモードでは継続利用できる概要を表示します。必要な時だけ完全な証跡と最優先の修正へ 1 クリックで戻れます。 |
| グローバル運用受信箱 | 公開ブロッカー、SSH と資産のカバレッジ不足、未完了イベントを優先度別にまとめ、対応モジュールへ直接移動します。確認状態は安全な安定 ID と時刻だけをブラウザーに保存します。 |
| モバイル クイック操作 | モバイルの 1 行目にはナビゲーション、公開チェック、コマンドパレットを残し、運用受信箱、パフォーマンスモード、言語、更新、アカウント設定、ログアウトはアクセス可能なコンパクトドロワーにまとめます。 |
| コンテキスト コマンドパレット | 現在の最優先項目、最近使った安全な操作、すべての操作を分けて表示します。履歴は最大 5 件のブラウザー内操作 ID だけを保存し、いつでも消去できます。 |
| AI 運用 | OpenAI 互換 API、モデル取得、ストリーミング会話、複数ターン文脈、キャッシュ、強制更新、接続テスト。新しい会話では、リスク確認、SSH ヘルスチェック準備、今日の優先順位付けという 3 つの安全な入口を表示します。クリックは入力欄を埋めるだけで、自動送信や実行は行いません。 |
| 運用自動化 | 資産同期、ヘルスチェック、SSH コマンド、再起動/停止などを実行前チェック付きで実行。 |
| カスタム API | サーバー側の安全なプロキシでクラウド API を検証し、プライベートネットワークや危険なヘッダーを遮断。 |
| セキュリティ監査 | ログイン、API、SSH、運用タスク、修復操作、リリース証跡を監査ログに保存し、外部レビュー向けに期限付き・取り消し可能な匿名化スナップショットを作成できます。 |
| オペレーター アカウント | ログイン、表示中は 15 秒ごとのアクティブ端末同期、設定可能なセッション上限と最古セッションの自動ログアウト、他セッションの個別または一括無効化、パスワード変更、3 言語切り替え、アバター設定。セッション一覧は生の IP や User-Agent を返さず、画像は保存前にデコード検証し、壊れた履歴画像は CoLiPas ブランドアイコンへ自動的に戻します。 |

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
| `SESSION_MAX_ACTIVE` | 管理者の最大アクティブセッション数。2～64、既定値は 12 で、上限到達時は最も古いセッションをログアウトします。 |
| `COLIPAS_DATA_DIR` | ランタイムデータディレクトリ。既定は `.data`。 |
| `COLIPAS_DB_PATH` | SQLite DB パス。既定はデータディレクトリ内です。 |
| `CREDENTIAL_ENCRYPTION_KEY` | 保存済み SSH 認証情報を暗号化する長いキー。 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 任意の OpenAI 互換プロバイダー設定。 |
| `CUSTOM_API_ALLOWED_HOSTS` | カスタム API テストで許可するホスト一覧。 |
| `RELEASE_VERIFY_TOKEN` | 任意のリリース検証 API 用 Bearer Token。 |

## 本番デプロイ

本番デプロイは Docker Compose とネイティブ Linux + systemd の 2 つのワンコマンド方式に対応しています。多くの利用者には Docker を推奨します。ホストの systemd で直接サービス管理したい場合はネイティブ Linux を選んでください。デプロイ利用者は下のワンコマンドスクリプトを実行するだけで、コードを push したり、Docker イメージをビルドまたは公開したりする必要はありません。

### Docker ワンコマンドデプロイ（推奨）

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_DEPLOY_MODE=docker \
  bash
```

推奨値:

| 項目 | 推奨値 |
| --- | --- |
| Install directory | `/opt/colipas` |
| Git branch | `master` |
| Public URL or domain | HTTPS ドメイン、例 `https://colipas.example.com` |
| Admin username | `admin` または運用アカウント名 |
| Deployment mode | `Docker Compose` |
| Initial admin password | 強いパスワードを入力、または空欄で自動生成 |

インストーラーは秘密情報をサーバー上にだけ保存します。`/opt/colipas/.env` が既に存在する場合、現在の管理者パスワード、DB パス、SSH 暗号化キー、AI 設定、その他のランタイム設定を保持します。入力または環境変数で指定した初期パスワードは、デプロイ完了時に再表示されません。自動生成されたパスワードだけが 1 回表示されます。

無人インストールでは環境変数で同じ値を渡せます。

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' \
  COLIPAS_DEPLOY_MODE=docker \
  COLIPAS_ASSUME_YES=1 \
  bash
```

主なオプション: `COLIPAS_APP_DIR`、`COLIPAS_BRANCH`、`COLIPAS_ADMIN_USERNAME`、`COLIPAS_DEPLOY_MODE=docker|native`、`COLIPAS_NON_INTERACTIVE=1`、`COLIPAS_ASSUME_YES=1`。

Docker デプロイは Compose ボリュームを保持するため、SQLite データ、監査ログ、暗号化済み SSH メタデータ、AI 設定、アカウント設定はコンテナ再作成後も残ります。

### ネイティブ Linux + systemd ワンコマンドデプロイ

Docker ではなく、ホストの systemd サービスとして CoLiPas クラウドサーバー管理パネルを動かしたい場合に使います。apt 系の Linux では Node.js 24 を必要に応じてインストールし、`colipas` サービスユーザーを作成し、アプリをビルドし、`deploy/colipas.service` をインストールして起動し、ヘルスチェックを実行します。

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_DEPLOY_MODE=native \
  bash
```

無人ネイティブ Linux デプロイ:

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' \
  COLIPAS_DEPLOY_MODE=native \
  COLIPAS_ASSUME_YES=1 \
  bash
```

ネイティブモードのランタイムデータは通常 `/opt/colipas/.data` に保存され、再デプロイ時も既存の `.env` シークレットを保持します。apt 系以外のサーバーでは先に Node.js 24 をインストールするか、Docker モードを使ってください。

## 管理者パスワードを忘れた場合

CoLiPas クラウドサーバー管理パネルは平文パスワードを保存せず、`scrypt` ハッシュだけを保存します。忘れた場合は復元ではなくリセットします。

Docker ワンコマンドデプロイ / Docker Compose:

```bash
cd /opt/colipas
docker compose exec -e COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' colipas npm run reset:admin
docker compose restart colipas
```

ネイティブ Linux + systemd:

```bash
cd /opt/colipas
sudo -u colipas env COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' npm run reset:admin
sudo systemctl restart colipas
```

このスクリプトは管理者アカウントだけを更新します。サーバー、SSH 認証情報、監査ログ、AI キャッシュ、カスタム API 設定、その他のランタイムデータは削除しません。

## セキュリティモデル

- ヘルスチェックと認証以外の運用 API はログインが必要です。
- セッション Cookie は HTTP-only です。アカウント設定は表示中に 15 秒ごとに匿名化されたアクティブ端末を同期し、設定済みの上限を適用します。他のセッションは個別または一括で無効化でき、パスワード変更時も他の全セッションを失効させます。
- SSH コマンドの監査要約はマスクされ、長さも制限されます。
- SSH 認証情報は `CREDENTIAL_ENCRYPTION_KEY` で暗号化されます。
- カスタム API プロキシはプライベート IP、リンクローカル、危険なヘッダー、機密ネットワークへのリダイレクトを遮断します。
- リリース検証、診断エクスポート、監査レポートはキー、秘密鍵、実ランタイムデータを漏らさない設計です。
- 管理者は期限付きで取り消し可能なリリース証跡リンクを作成できます。リンクには固定の集計スナップショットのみを含め、サーバーアドレス、デプロイ先、コミット ID、コマンド、認証情報、監査詳細、ユーザーデータを含めません。作成・閲覧・取り消しは監査されます。
- 公開ログイン画面にはサービス可用性、アクセス保護、最終確認時刻のみを表示します。データベース、デプロイ先、リリース識別子はログイン後の監査ワークスペースでのみ確認できます。

## 検証

コミットや公開前に推奨されるコマンド:

```bash
npm test
npm audit --omit=dev --audit-level=high
node scripts/secret-scan.mjs
```

完全なテストは、ビルド、一時的な本番サービス、API スモーク、ブラウザー検証、性能チェック、並行処理チェック、管理者パスワードリセット検証を実行します。
