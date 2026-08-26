-- コントロールプレーンDB: テナント・デバイス・シャード割当ディレクトリ
-- 生イベントは置かない（D1の行課金・10GB/DB制限のため、イベントはシャードDBへ）

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shard_id TEXT NOT NULL,          -- ディレクトリ方式: このテナントのイベントが入るシャード
  api_key_hash TEXT NOT NULL,      -- SHA-256(api_key) 平文キーは保存しない
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_key ON tenants(api_key_hash);

-- テナント毎の検知ポリシー(JSON)。エージェントが定期取得してローカルルールに反映する
CREATE TABLE IF NOT EXISTS policies (
  tenant_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  agent_version TEXT,
  PRIMARY KEY (tenant_id, id)
);
