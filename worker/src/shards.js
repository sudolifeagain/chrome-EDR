// シャードディレクトリ
// MVP: 静的バインディング2枚。本番はテナント毎D1を動的作成し、この一覧を
// コントロールDB側のディレクトリに置き換える（D1はアカウントあたり最大50,000DB）。

export const SHARD_IDS = ["00", "01"];

export function shardBinding(env, shardId) {
  const binding = env[`DB_SHARD_${shardId}`];
  if (!binding) throw new Error(`unknown shard: ${shardId}`);
  return binding;
}

// 新規テナントのシャード割当（ディレクトリ方式・ラウンドロビン）
export async function assignShard(controlDb) {
  const { cnt } = await controlDb
    .prepare("SELECT COUNT(*) AS cnt FROM tenants")
    .first();
  return SHARD_IDS[cnt % SHARD_IDS.length];
}
