-- イベントシャードDB: append専用のイベントストア
--
-- D1は「スキャンした行数」で課金されるため（返した行数ではない）、索引設計がそのまま請求額になる。
-- 採用テクニック（docs/architecture.md参照）:
--   1. 主要クエリ (tenant×時刻) にのみフル複合索引
--   2. severity索引は部分索引: イベントの大半を占める info には索引行の書き込み課金を発生させない
--   3. ダッシュボード集計は rollup_hourly を読む（生イベントのスキャンを避ける）
--   4. 保持期限は時間ローテーションしたシャードDBごとDROP（DELETEは行課金されるため）

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,             -- epoch millis (クライアント時刻)
  type TEXT NOT NULL,              -- nav.completed / download.created / extension.* / alert.*
  severity TEXT NOT NULL DEFAULT 'info',  -- info / warn / critical
  payload TEXT                     -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_ts ON events(tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_alerts
  ON events(tenant_id, severity, ts DESC) WHERE severity != 'info';

-- ダッシュボード用の時間別ロールアップ（取り込み時にupsertで維持）
CREATE TABLE IF NOT EXISTS rollup_hourly (
  tenant_id TEXT NOT NULL,
  hour INTEGER NOT NULL,           -- epoch millis を時間単位に切り捨て
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, hour, type, severity)
) WITHOUT ROWID;

ANALYZE;
