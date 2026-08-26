# アーキテクチャ設計: D1分散シャーディングとコスト最適化

調査日: 2026-08-26。価格・制限は developers.cloudflare.com の公式ドキュメントに基づく。

## 全体像

```
ブラウザ拡張エージェント --バッチPOST(1分間隔)--> Ingest Worker
                                                   ├─ コントロールDBでテナント認証 + シャード解決（ディレクトリ方式）
                                                   ├─ 複数行INSERT + batch() でシャードDBへ書き込み
                                                   └─ rollup_hourly を upsert（ダッシュボード用集計）
コントロールDB (D1): tenants / devices / シャード割当ディレクトリ
シャードDB群 (D1): events + rollup_hourly
ダッシュボードWorker: rollupを読む。生イベントはドリルダウン時のみ keyset pagination
```

## なぜシャーディングか

- D1は **1DBあたり最大10GB**、アカウントあたり最大 **50,000DB / 1TB**（Paid）
- 単一DBではテレメトリ量で天井に当たる。テナント毎（将来は時間ローテーション併用）にDBを分割する
- **ディレクトリ方式ルーティング**を採用: コントロールDBの `tenants.shard_id` がテナント→シャードの対応を保持。ハッシュ方式と違い、大口テナントの専用シャード割当やリバランスが可能
- MVPは静的バインディング2枚（`DB_SHARD_00/01`）で機構を実証。バインディングは1 Workerあたり約5,000まで可能なので、当面は「事前確保したバインディングプール + ディレクトリ割当」で拡張し、テナント作成時の動的D1作成（REST API）はプロビジョニング専用に使う
  - 注意: REST APIのデータパス利用はグローバルレート制限（1,200リクエスト/5分）があり本番データパスには使えない。クエリは必ずバインディング経由

## D1課金モデル（設計の前提）

| 指標 | Workers Paid込み | 超過 |
|---|---|---|
| rows_read | 250億行/月 | $0.001/百万行 |
| rows_written | 5,000万行/月 | $1.00/百万行 |
| ストレージ | 5GB | $0.75/GB-月 |

重要な性質:
- **rows_read は「スキャンした行数」**。返した行数ではない。索引がない列でのフィルタは全行スキャン=全行課金
- `COUNT(*)` は全行スキャン。`OFFSET` はスキップ行も課金
- **索引は書き込みを2倍にする**: 索引対象列を含むINSERTは表+索引で行書き込みが増える
- DELETEも行課金される（削除行数分の rows_written + 検索の rows_read）

## 採用したコスト最適化テクニック

1. **複合索引はホットクエリのみ**: `(tenant_id, ts DESC)` の1本。イベント一覧・時系列取得をカバー
2. **アラート索引は部分索引**: `WHERE severity != 'info'` 付き。イベントの大半（99%想定）を占める info の INSERT には索引書き込み課金が発生しない
3. **rollup_hourly テーブル**: 取り込み時に `ON CONFLICT DO UPDATE` で時間別集計を維持。ダッシュボードのグラフは数百行の rollup を読むだけで済み、生イベントの数百万行スキャンを避ける
4. **複数行INSERT + batch()**: バインド変数上限100に収まるよう12行/文でチャンク。rows_written は同じだがラウンドトリップ・クエリ数を削減
5. **keyset pagination**: `WHERE ts < ? ORDER BY ts DESC LIMIT n`。OFFSET・COUNT(*)は使わない
6. **テナント解決のin-isolateキャッシュ**: 毎リクエストのコントロールDB読取を削減
7. **エージェント側バッチ送信**: 1分間隔でまとめてPOST。リクエスト数とクエリ数を抑制
8. **INSERT OR IGNORE による冪等化**: リトライ時の重複行書き込みを防ぐ
9. **保持期限は「シャードDBごとDROP」**（本番設計）: 時間ローテーション（例: テナント×四半期）したシャードを期限切れでDROPすれば行課金ゼロ。DELETEによる削除は行課金されるため使わない。DROP前にR2へJSONL.gzで書き出してアーカイブ（R2は$0.015/GB-月、egress無料）
10. **観測**: 各クエリの `meta.rows_read/rows_written` をログし、`wrangler d1 insights --sort-by=reads` で queryEfficiency（返却行÷スキャン行 ≒ 1.0 が理想）を定期監査

## コスト試算（1,000エージェント × 200イベント/日 ≒ 月600万イベント）

| 項目 | 計算 | 月額 |
|---|---|---|
| rows_written | 600万 ×（本体1 + フル索引1 + 部分索引~0.01）≒ 1,210万行 | 込み枠内 $0 |
| rows_read（ダッシュボード） | rollup経由で ~6億行/月 | 込み枠内 $0 |
| ストレージ | ~0.6KB/イベント、90日保持で ~11GB | 超過6GB ≒ $4.50 |
| Workers Paid基本料 | | $5.00 |
| **合計** | | **≒ $10/月** |

10,000エージェント（月6,000万イベント）では書き込み超過 ~$71 + ストレージ ~$79 が発生。その時点での移行先:
1. ホット保持期間を30日に短縮（残りはR2）
2. 良性イベントのファイアホースを Workers Analytics Engine へ（$0.25/百万ポイント、現在は課金保留中。ただし90日保持・サンプリングありのためアラート/フォレンジックには使わない）
3. テナント作成を完全動的にしたくなったら Durable Objects (SQLite) のテナント毎オブジェクトを検討（`idFromName()` で実行時アドレス可能・ストレージ$0.20/GB-月でD1の3.75分の1。ただしテナント毎シングルスレッド）

## 参考情報源

- developers.cloudflare.com: D1 pricing / limits / use-indexes / read-replication / metrics-analytics, Queues pricing, R2 pricing, Durable Objects pricing, Analytics Engine pricing
- 実例: fullstacksveltekit.com「$134 D1請求の教訓」（索引なし76万行テーブルが月4,000億rows_readを生み、索引+ANALYZE+キャッシュで95%削減）、sushidata.com「D1を卒業した理由」（テナント毎D1のREST API律速→DO SQLiteへ移行）、rxliuli.com「D1クエリ最適化の旅」（複数行INSERTで78ms→14ms、JOINファンアウト、OFFSETの罠）
