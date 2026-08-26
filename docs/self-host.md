# セルフホスト手順

chrome-EDR のバックエンドは自分のCloudflareアカウントにデプロイして運用できる。テレメトリは自組織のアカウントから外に出ない。

必要なもの: Cloudflareアカウント（Workers無料プランで可。無料枠はD1 5GB・10万行書き込み/日）、Node.js 20+。

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

## 運用メモ

- シャード追加: `wrangler.jsonc` に `DB_SHARD_02...` を追記し、`worker/src/shards.js` の `SHARD_IDS` に追加して再デプロイ（バインディングは1 Workerあたり約5,000まで）
- 保持期限: 将来は時間ローテーションしたシャードDBをDROPする運用を推奨（DELETEは行課金されるため）。詳細は [architecture.md](architecture.md)
- コスト目安: 1,000エージェント規模で月$10程度（Workers Paid $5 + D1ストレージ超過分）
