# セルフホスト手順

chrome-EDR のバックエンドは自分のCloudflareアカウントにデプロイして運用できる。テレメトリは自組織のアカウントから外に出ない。

必要なもの: Cloudflareアカウント（Workers無料プランで可。無料枠はD1 5GB・10万行書き込み/日）、Node.js 22.23.4 以降の22系、24.22.1 以降の24系、または26.12.1以降。

## 1. リポジトリ取得と依存インストール

```bash
git clone https://github.com/sudolifeagain/chrome-EDR.git
cd chrome-EDR/worker
npm install
```

## 2. D1データベース作成

```bash
npx wrangler login
npx wrangler d1 create chrome-edr-control
npx wrangler d1 create chrome-edr-shard-00
npx wrangler d1 create chrome-edr-shard-01
```

出力された各 `database_id` を `wrangler.jsonc` の対応する項目に貼り付ける。

## 3. スキーマ適用

```bash
npx wrangler d1 execute DB_CONTROL --remote --file=schema/control.sql
npx wrangler d1 execute DB_SHARD_00 --remote --file=schema/shard.sql
npx wrangler d1 execute DB_SHARD_01 --remote --file=schema/shard.sql
```

## 4. 管理キー設定とデプロイ

```bash
npx wrangler secret put ADMIN_KEY   # 十分に長いランダム文字列を入力
npx wrangler deploy
```

デプロイURL（例: `https://chrome-edr.<your>.workers.dev`）が発行される。

## 5. テナント作成

```bash
curl -X POST https://chrome-edr.<your>.workers.dev/v1/tenants \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"MyCompany"}'
```

レスポンスの `api_key` を控える（**この時だけ表示**。サーバにはハッシュのみ保存される）。

## 6. エージェント配布

1. `agent/` を各端末のChromeに読み込む（組織展開は `ExtensionInstallForcelist` ポリシー + 自社ストア/CRXで配布）
2. 拡張の「オプション」でエンドポイントURLとテナントAPIキーを設定
3. ダッシュボード（デプロイURLのトップページ）を開き、テナントAPIキーで表示

## 7. ポリシー設定（任意）

検知の挙動はテナント毎にサーバから配信できる。エージェントは5分間隔で取得し、未設定なら既定値で動く。

```bash
curl -X PUT https://chrome-edr.<your>.workers.dev/v1/tenants/<テナントID>/policy \
  -H "Authorization: Bearer <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "notify": "warn",
    "aiHosts": ["internal-ai.example.com"],
    "rules": {
      "ai-mass-paste": { "warnChars": 500, "criticalChars": 2000 },
      "lookalike-domain": { "extraProtectedDomains": ["mycorp.co.jp"] },
      "extension-installed": { "enabled": true }
    }
  }'
```

- `notify`: デスクトップ通知するレベル（`critical` / `warn` / `off`。既定は critical）
- `aiHosts`: 生成AI訪問検知に追加するホスト。注意: 貼り付け検知の対象サイトは拡張のマニフェストで静的に決まるため、追加ホストは「訪問の可視化」にのみ効く
- `rules.<ルールID>.enabled: false` でルール単位の無効化

## Deploy to Cloudflare ボタン

READMEのボタンからも自分のアカウントにデプロイできる。ウィザードでルートディレクトリに `worker` を指定すること。D1バインディングは自動プロビジョニングされるが、スキーマ適用（手順3）とADMIN_KEY設定（手順4）は手動で行う。

## 運用メモ

- シャード追加: `wrangler.jsonc` に `DB_SHARD_02...` を追記し、`worker/src/shards.js` の `SHARD_IDS` に追加して再デプロイ（バインディングは1 Workerあたり約5,000まで）
- 保持期限: 将来は時間ローテーションしたシャードDBをDROPする運用を推奨（DELETEは行課金されるため）。詳細は [architecture.md](architecture.md)
- コスト目安: 1,000エージェント規模で月$10程度（Workers Paid $5 + D1ストレージ超過分）
