// 管理コンソール (Worker-served, 依存ゼロの単一HTML)
// 管理者キーで、テナント作成・ポリシー編集・シャード統計の閲覧ができる。
// ラベルは平易な日本語（わかりやすさ要件は管理者向け画面にも適用する）

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>chrome-EDR 管理コンソール</title>
<style>
  :root { --bg:#f8fafc; --card:#fff; --line:#e2e8f0; --text:#0f172a; --muted:#64748b; --accent:#0e7490; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.7 system-ui,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; }
  h1 small { font-weight: 400; font-size: 13px; color: var(--muted); margin-left: 8px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin:16px 0; }
  h2 { font-size:17px; margin-top:0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom:0; }
  input, select, textarea {
    padding:8px; border:1px solid var(--line); border-radius:8px; font:inherit; width:100%;
  }
  input[type="number"] { width:110px; }
  input[type="checkbox"] { width:auto; }
  label { font-size:13.5px; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:10px 0; }
  .row > span.desc { color:var(--muted); font-size:12.5px; flex-basis:100%; margin-top:-6px; }
  button {
    padding:8px 20px; border:0; border-radius:8px; background:var(--text); color:#fff; cursor:pointer; font:inherit;
  }
  button.small { padding:4px 12px; font-size:12.5px; background:var(--accent); }
  .hidden { display:none; }
  .muted { color:var(--muted); }
  .keybox {
    background:#f1f5f9; border:1px dashed var(--accent); border-radius:8px; padding:12px 16px; margin-top:12px;
    font-family: ui-monospace, monospace; word-break: break-all;
  }
  #status, #polStatus { margin-left:12px; color:#15803d; font-size:13px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <h1>chrome-EDR 管理コンソール<small><a href="/">← ダッシュボードへ</a></small></h1>

  <div id="setup" class="card">
    <p>管理者キー（ADMIN_KEY）を入力してください。この端末のブラウザにのみ保存されます。</p>
    <div class="row">
      <input id="adminKey" type="password" placeholder="管理者キー" style="max-width:420px" />
      <button id="connect">接続</button>
    </div>
    <p id="setupError" class="muted"></p>
  </div>

  <div id="main" class="hidden">
    <div class="card">
      <h2>テナント</h2>
      <table><thead><tr><th>名前</th><th>シャード</th><th>端末数</th><th>ポリシー</th><th></th></tr></thead>
      <tbody id="tenants"></tbody></table>
      <div class="row" style="margin-top:16px">
        <input id="newName" placeholder="新しいテナント名（例: 株式会社サンプル）" style="max-width:340px" />
        <button id="create">テナントを作成</button><span id="status"></span>
      </div>
      <div id="newKey" class="hidden keybox"></div>
    </div>

    <div id="policyCard" class="card hidden">
      <h2>ポリシー編集: <span id="polTenantName"></span></h2>
      <p class="muted" style="font-size:13px">保存すると、このテナントの全端末に最大5分で反映されます。</p>

      <div class="row">
        <label>デスクトップ通知を出す条件</label>
        <select id="pNotify" style="max-width:280px">
          <option value="critical">「危険」のときだけ通知（既定）</option>
          <option value="warn">「注意」以上で通知</option>
          <option value="off">通知しない</option>
        </select>
      </div>

      <div class="row">
        <label><input type="checkbox" id="pPasteOn" /> 生成AIへの大量貼り付けを検知する</label>
        <span>注意:</span><input type="number" id="pWarnChars" min="1" />
        <span>危険:</span><input type="number" id="pCritChars" min="1" />
        <span class="desc">貼り付けた文字数がこの値以上でアラートになります。本文は収集しません。</span>
      </div>

      <div class="row">
        <label><input type="checkbox" id="pLookalikeOn" /> 有名サイトのなりすましドメインを検知する</label>
        <input id="pProtected" placeholder="追加で守りたい自社ドメイン（カンマ区切り。例: mycorp.co.jp）" />
      </div>

      <div class="row">
        <label><input type="checkbox" id="pPunyOn" /> 偽装文字ドメイン（Punycode）を検知する</label>
      </div>

      <div class="row">
        <label><input type="checkbox" id="pExtOn" /> 拡張機能のインストールを検知する</label>
      </div>

      <div class="row">
        <label>利用を記録する生成AIサイトの追加</label>
        <input id="pAiHosts" placeholder="カンマ区切り。例: internal-ai.example.com（訪問の可視化にのみ反映）" />
      </div>

      <div class="row"><button id="polSave">ポリシーを保存</button><span id="polStatus"></span></div>
    </div>

    <div class="card">
      <h2>シャード統計（日次更新）</h2>
      <table><thead><tr><th>シャード</th><th>直近90日のイベント数</th><th>テナント数</th><th>集計日</th></tr></thead>
      <tbody id="stats"></tbody></table>
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let adminKey = null;
let editingTenant = null;

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ Authorization: "Bearer " + adminKey }, opts.headers || {});
  return fetch(path, opts).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

async function loadTenants() {
  const res = await api("/v1/tenants");
  $("tenants").innerHTML = res.tenants.length === 0
    ? '<tr><td colspan="5" class="muted">テナントはまだありません。下のフォームから作成してください。</td></tr>'
    : res.tenants.map((t) =>
        '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.shard_id) + '</td>' +
        '<td>' + t.devices + '</td><td>' + (t.has_policy ? "設定あり" : "既定") + '</td>' +
        '<td><button class="small" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">ポリシー編集</button></td></tr>'
      ).join("");
  for (const btn of document.querySelectorAll("#tenants button")) {
    btn.addEventListener("click", () => openPolicy(btn.dataset.id, btn.dataset.name));
  }
}

async function loadStats() {
  const res = await api("/v1/shard-stats");
  $("stats").innerHTML = res.stats.length === 0
    ? '<tr><td colspan="4" class="muted">まだ統計がありません（日次Cronの初回実行後に表示されます）。</td></tr>'
    : res.stats.map((s) =>
        '<tr><td>' + esc(s.shard_id) + '</td><td>' + s.events_total.toLocaleString() + '件</td>' +
        '<td>' + s.tenants + '</td><td>' + esc(s.day) + '</td></tr>'
      ).join("");
}

const DEFAULTS = {
  notify: "critical",
  aiHosts: [],
  rules: {
    "punycode-domain": { enabled: true },
    "lookalike-domain": { enabled: true, extraProtectedDomains: [] },
    "extension-installed": { enabled: true },
    "ai-mass-paste": { enabled: true, warnChars: 1000, criticalChars: 5000 },
  },
};

async function openPolicy(id, name) {
  editingTenant = id;
  $("polTenantName").textContent = name;
  const res = await api("/v1/tenants/" + id + "/policy");
  const p = res.policy || {};
  const rules = p.rules || {};
  const g = (rid, key) => {
    const r = rules[rid] || {};
    return r[key] !== undefined ? r[key] : DEFAULTS.rules[rid][key];
  };
  $("pNotify").value = p.notify || DEFAULTS.notify;
  $("pPasteOn").checked = g("ai-mass-paste", "enabled") !== false;
  $("pWarnChars").value = g("ai-mass-paste", "warnChars");
  $("pCritChars").value = g("ai-mass-paste", "criticalChars");
  $("pLookalikeOn").checked = g("lookalike-domain", "enabled") !== false;
  $("pProtected").value = (g("lookalike-domain", "extraProtectedDomains") || []).join(", ");
  $("pPunyOn").checked = g("punycode-domain", "enabled") !== false;
  $("pExtOn").checked = g("extension-installed", "enabled") !== false;
  $("pAiHosts").value = (p.aiHosts || []).join(", ");
  $("policyCard").classList.remove("hidden");
  $("policyCard").scrollIntoView({ behavior: "smooth" });
}

function csv(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

$("polSave").addEventListener("click", async () => {
  const policy = {
    notify: $("pNotify").value,
    aiHosts: csv($("pAiHosts").value),
    rules: {
      "ai-mass-paste": {
        enabled: $("pPasteOn").checked,
        warnChars: Number($("pWarnChars").value) || 1000,
        criticalChars: Number($("pCritChars").value) || 5000,
      },
      "lookalike-domain": {
        enabled: $("pLookalikeOn").checked,
        extraProtectedDomains: csv($("pProtected").value),
      },
      "punycode-domain": { enabled: $("pPunyOn").checked },
      "extension-installed": { enabled: $("pExtOn").checked },
    },
  };
  try {
    await api("/v1/tenants/" + editingTenant + "/policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policy),
    });
    $("polStatus").textContent = "保存しました（端末への反映は最大5分）";
    setTimeout(() => ($("polStatus").textContent = ""), 4000);
    loadTenants();
  } catch (e) {
    $("polStatus").textContent = "保存できませんでした: " + e.message;
  }
});

$("create").addEventListener("click", async () => {
  const name = $("newName").value.trim();
  if (!name) return;
  try {
    const t = await api("/v1/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    $("newName").value = "";
    $("newKey").classList.remove("hidden");
    $("newKey").textContent = "「" + name + "」のAPIキー（この画面でしか表示されません。今すぐ控えてください）: " + t.api_key;
    loadTenants();
  } catch (e) {
    $("status").textContent = "作成できませんでした: " + e.message;
  }
});

async function connect(key) {
  adminKey = key;
  try {
    await Promise.all([loadTenants(), loadStats()]);
    try { localStorage.setItem("edrAdminKey", key); } catch {}
    $("setup").classList.add("hidden");
    $("main").classList.remove("hidden");
  } catch (e) {
    $("setupError").textContent = "接続できませんでした: " + e.message;
  }
}

$("connect").addEventListener("click", () => connect($("adminKey").value.trim()));
let saved = null;
try { saved = localStorage.getItem("edrAdminKey"); } catch {}
if (saved) connect(saved);
</script>
</body>
</html>`;
