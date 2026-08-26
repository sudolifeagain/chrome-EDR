// chrome-EDR backend: イベント取り込みAPI + テナント管理
// D1分散シャーディング: コントロールDB(テナント/デバイス) + イベントシャードDB群

import { SHARD_IDS, shardBinding, assignShard } from "./shards.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { ADMIN_HTML } from "./admin.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

// D1のバインド変数上限(100)に収まるよう、複数行INSERTは12行ずつ (7列 × 12 = 84)
const INSERT_CHUNK = 12;
const EVENT_COLUMNS = 7;

// テナント解決のin-isolateキャッシュ: リクエスト毎のコントロールDB読取(rows_read)を削減
const tenantCache = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function resolveTenant(env, request) {
  const key = bearerToken(request);
  if (!key) return null;
  const keyHash = await sha256hex(key);

  const cached = tenantCache.get(keyHash);
  if (cached) return cached;

  const tenant = await env.DB_CONTROL.prepare(
    "SELECT id, shard_id FROM tenants WHERE api_key_hash = ?"
  )
    .bind(keyHash)
    .first();
  if (tenant) tenantCache.set(keyHash, tenant);
  return tenant;
}

// --- POST /v1/tenants (管理者のみ): テナント作成 + シャード割当 ---
async function createTenant(env, request) {
  if (bearerToken(request) !== env.ADMIN_KEY || !env.ADMIN_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await request.json().catch(() => ({}));
  if (!body.name) return json({ error: "name is required" }, 400);

  const id = crypto.randomUUID();
  const apiKey = crypto.randomUUID().replaceAll("-", "");
  const shardId = await assignShard(env.DB_CONTROL);

  await env.DB_CONTROL.prepare(
    "INSERT INTO tenants (id, name, shard_id, api_key_hash, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, body.name, shardId, await sha256hex(apiKey), Date.now())
    .run();

  // apiKey はこのレスポンスでのみ返す（保存はハッシュのみ）
  return json({ id, name: body.name, shard_id: shardId, api_key: apiKey }, 201);
}

// --- POST /v1/events: バッチ取り込み ---
async function ingestEvents(env, request) {
  const tenant = await resolveTenant(env, request);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.events) || !body.device?.id) {
    return json({ error: "expected { device: { id }, events: [...] }" }, 400);
  }
  if (body.events.length === 0) return json({ accepted: 0 });
  if (body.events.length > 500) {
    return json({ error: "too many events in one batch (max 500)" }, 413);
  }

  const db = shardBinding(env, tenant.shard_id);
  const now = Date.now();

  const rows = body.events
    .filter((e) => e && e.id && e.type && Number.isFinite(e.ts))
    .map((e) => [
      String(e.id),
      tenant.id,
      String(body.device.id),
      e.ts,
      String(e.type),
      ["info", "warn", "critical"].includes(e.severity) ? e.severity : "info",
      JSON.stringify(e.payload ?? {}),
    ]);

  // 複数行INSERT + batch(): rows_writtenは同じだがラウンドトリップと課金対象クエリ数を削減
  // INSERT OR IGNORE でリトライ時の重複を冪等に排除 (idがPK)
  const statements = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const placeholders = chunk
      .map(() => `(${Array(EVENT_COLUMNS).fill("?").join(",")})`)
      .join(",");
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO events (id, tenant_id, device_id, ts, type, severity, payload) VALUES ${placeholders}`
        )
        .bind(...chunk.flat())
    );
  }
  // ロールアップ維持: ダッシュボードが生イベントをスキャンしない(rows_read削減)ための upsert
  const HOUR = 3600_000;
  const rollups = new Map();
  for (const r of rows) {
    const key = `${Math.floor(r[3] / HOUR) * HOUR}|${r[4]}|${r[5]}`;
    rollups.set(key, (rollups.get(key) ?? 0) + 1);
  }
  for (const [key, n] of rollups) {
    const [hour, type, severity] = key.split("|");
    statements.push(
      db
        .prepare(
          `INSERT INTO rollup_hourly (tenant_id, hour, type, severity, n) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, hour, type, severity) DO UPDATE SET n = n + excluded.n`
        )
        .bind(tenant.id, Number(hour), type, severity, n)
    );
  }

  if (statements.length > 0) await db.batch(statements);

  await env.DB_CONTROL.prepare(
    `INSERT INTO devices (id, tenant_id, first_seen, last_seen, agent_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       last_seen = excluded.last_seen,
       agent_version = excluded.agent_version`
  )
    .bind(body.device.id, tenant.id, now, now, body.device.agentVersion ?? null)
    .run();

  return json({ accepted: rows.length });
}

// --- GET /v1/events, /v1/alerts: keyset pagination (OFFSETはスキャン行が課金されるため使わない) ---
async function listEvents(env, request, url, { alertsOnly = false } = {}) {
  const tenant = await resolveTenant(env, request);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const before = Number(url.searchParams.get("before")) || null;
  const severity = url.searchParams.get("severity");

  const where = ["tenant_id = ?"];
  const params = [tenant.id];
  if (alertsOnly) {
    // 部分索引 idx_events_alerts (WHERE severity != 'info') に乗る
    where.push("severity != 'info'");
  }
  if (severity) {
    where.push("severity = ?");
    params.push(severity);
  }
  if (before) {
    where.push("ts < ?");
    params.push(before);
  }

  const db = shardBinding(env, tenant.shard_id);
  const { results } = await db
    .prepare(
      `SELECT id, device_id, ts, type, severity, payload FROM events
       WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`
    )
    .bind(...params, limit)
    .all();

  const events = results.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  const nextCursor =
    events.length === limit ? events[events.length - 1].ts : null;
  return json({ events, nextCursor });
}

// --- ポリシー配信 ---
// GET /v1/policy (テナントキー): エージェントが定期取得
async function getPolicy(env, request) {
  const tenant = await resolveTenant(env, request);
  if (!tenant) return json({ error: "unauthorized" }, 401);
  const row = await env.DB_CONTROL.prepare(
    "SELECT policy, updated_at FROM policies WHERE tenant_id = ?"
  )
    .bind(tenant.id)
    .first();
  if (!row) return json({ policy: null, updatedAt: null });
  return json({ policy: JSON.parse(row.policy), updatedAt: row.updated_at });
}

// PUT /v1/tenants/:id/policy (管理者キー): ポリシー更新
async function putPolicy(env, request, tenantId) {
  if (bearerToken(request) !== env.ADMIN_KEY || !env.ADMIN_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "policy JSON body is required" }, 400);
  }
  const exists = await env.DB_CONTROL.prepare(
    "SELECT id FROM tenants WHERE id = ?"
  )
    .bind(tenantId)
    .first();
  if (!exists) return json({ error: "unknown tenant" }, 404);

  await env.DB_CONTROL.prepare(
    `INSERT INTO policies (tenant_id, policy, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET
       policy = excluded.policy, updated_at = excluded.updated_at`
  )
    .bind(tenantId, JSON.stringify(body), Date.now())
    .run();
  return json({ ok: true });
}

// --- GET /v1/summary: 直近24時間の状況 (rollup_hourlyのみ読む = rows_read数十行) ---
async function summary(env, request) {
  const tenant = await resolveTenant(env, request);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  const since = Date.now() - 24 * 3600_000;
  const db = shardBinding(env, tenant.shard_id);
  const { results } = await db
    .prepare(
      `SELECT severity, type, SUM(n) AS n FROM rollup_hourly
       WHERE tenant_id = ? AND hour >= ? GROUP BY severity, type`
    )
    .bind(tenant.id, since)
    .all();

  const bySeverity = { info: 0, warn: 0, critical: 0 };
  const byType = {};
  for (const r of results) {
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + r.n;
    byType[r.type] = (byType[r.type] ?? 0) + r.n;
  }
  // 信号機ステータス: セキュリティ非専門者向けの3段階表示
  const status =
    bySeverity.critical > 0 ? "danger" : bySeverity.warn > 0 ? "caution" : "ok";
  return json({ status, bySeverity, byType, since });
}

// --- 管理API (ADMIN_KEY必須) ---
function isAdmin(env, request) {
  return env.ADMIN_KEY && bearerToken(request) === env.ADMIN_KEY;
}

// GET /v1/tenants: テナント一覧（デバイス数・ポリシー有無つき）
async function listTenants(env, request) {
  if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB_CONTROL.prepare(
    `SELECT t.id, t.name, t.shard_id, t.created_at,
       (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id) AS devices,
       EXISTS(SELECT 1 FROM policies p WHERE p.tenant_id = t.id) AS has_policy
     FROM tenants t ORDER BY t.created_at DESC`
  ).all();
  return json({ tenants: results });
}

// GET /v1/tenants/:id/policy: 管理者による任意テナントのポリシー取得（編集フォームの初期値用）
async function getPolicyAsAdmin(env, request, tenantId) {
  if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
  const row = await env.DB_CONTROL.prepare(
    "SELECT policy, updated_at FROM policies WHERE tenant_id = ?"
  )
    .bind(tenantId)
    .first();
  if (!row) return json({ policy: null, updatedAt: null });
  return json({ policy: JSON.parse(row.policy), updatedAt: row.updated_at });
}

// GET /v1/shard-stats: 日次Cronが収集した最新のシャード統計
async function shardStats(env, request) {
  if (!isAdmin(env, request)) return json({ error: "unauthorized" }, 401);
  const { results } = await env.DB_CONTROL.prepare(
    `SELECT day, shard_id, events_total, tenants FROM shard_stats
     WHERE day = (SELECT MAX(day) FROM shard_stats) ORDER BY shard_id`
  ).all();
  return json({ stats: results });
}

// --- GET /v1/ai-usage: 生成AIの利用状況 (直近24時間、ホスト別) ---
// 24時間窓に限定して idx_events_tenant_ts のレンジスキャンに乗せ、rows_readを抑える
async function aiUsage(env, request) {
  const tenant = await resolveTenant(env, request);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  const since = Date.now() - 24 * 3600_000;
  const db = shardBinding(env, tenant.shard_id);
  const { results } = await db
    .prepare(
      `SELECT type, payload FROM events
       WHERE tenant_id = ? AND ts >= ? AND type IN ('ai.visit', 'ai.paste')`
    )
    .bind(tenant.id, since)
    .all();

  const hosts = {};
  for (const r of results) {
    const p = JSON.parse(r.payload);
    if (!p.host) continue;
    const h = (hosts[p.host] ??= { visits: 0, pastes: 0, pastedChars: 0 });
    if (r.type === "ai.visit") h.visits++;
    else {
      h.pastes++;
      h.pastedChars += p.chars ?? 0;
    }
  }
  return json({ since, hosts });
}

// --- GET /v1/devices: 端末一覧 (コントロールDB) ---
async function listDevices(env, request) {
  const tenant = await resolveTenant(env, request);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  const { results } = await env.DB_CONTROL.prepare(
    `SELECT id, first_seen, last_seen, agent_version FROM devices
     WHERE tenant_id = ? ORDER BY last_seen DESC LIMIT 100`
  )
    .bind(tenant.id)
    .all();
  return json({ devices: results });
}

// --- 日次Cron: シャード統計の収集と古いロールアップの整理 ---
// rollup_hourly（小さな集計表）だけを読むので、統計収集自体がrows_read課金を膨らませない
async function collectShardStats(env) {
  const day = new Date().toISOString().slice(0, 10);
  const cutoff = Date.now() - 90 * 24 * 3600_000;
  for (const shardId of SHARD_IDS) {
    const db = shardBinding(env, shardId);
    await db.prepare("DELETE FROM rollup_hourly WHERE hour < ?").bind(cutoff).run();
    const row = await db
      .prepare(
        `SELECT COUNT(DISTINCT tenant_id) AS tenants, COALESCE(SUM(n), 0) AS events_total
         FROM rollup_hourly`
      )
      .first();
    await env.DB_CONTROL.prepare(
      `INSERT INTO shard_stats (day, shard_id, events_total, tenants) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, shard_id) DO UPDATE SET
         events_total = excluded.events_total, tenants = excluded.tenants`
    )
      .bind(day, shardId, row.events_total, row.tenants)
      .run();
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectShardStats(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (pathname === "/" || pathname === "/dashboard") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/admin") {
      return new Response(ADMIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/healthz") {
      return json({ ok: true, shards: SHARD_IDS });
    }
    if (pathname === "/v1/summary" && request.method === "GET") {
      return summary(env, request);
    }
    if (pathname === "/v1/policy" && request.method === "GET") {
      return getPolicy(env, request);
    }
    if (pathname === "/v1/ai-usage" && request.method === "GET") {
      return aiUsage(env, request);
    }
    if (pathname === "/v1/devices" && request.method === "GET") {
      return listDevices(env, request);
    }
    const policyMatch = pathname.match(/^\/v1\/tenants\/([0-9a-f-]{36})\/policy$/);
    if (policyMatch && request.method === "PUT") {
      return putPolicy(env, request, policyMatch[1]);
    }
    if (policyMatch && request.method === "GET") {
      return getPolicyAsAdmin(env, request, policyMatch[1]);
    }
    if (pathname === "/v1/tenants" && request.method === "GET") {
      return listTenants(env, request);
    }
    if (pathname === "/v1/shard-stats" && request.method === "GET") {
      return shardStats(env, request);
    }
    if (pathname === "/v1/tenants" && request.method === "POST") {
      return createTenant(env, request);
    }
    if (pathname === "/v1/events" && request.method === "POST") {
      return ingestEvents(env, request);
    }
    if (pathname === "/v1/events" && request.method === "GET") {
      return listEvents(env, request, url);
    }
    if (pathname === "/v1/alerts" && request.method === "GET") {
      return listEvents(env, request, url, { alertsOnly: true });
    }
    return json({ error: "not found" }, 404);
  },
};
