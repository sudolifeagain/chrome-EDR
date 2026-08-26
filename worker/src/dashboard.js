// 管理ダッシュボード (Worker-served, 依存ゼロの単一HTML)
// わかりやすさ最優先: 信号機式ステータス + アラートは「何が起きた/なぜ危険/次にすべきこと」を表示

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>chrome-EDR ダッシュボード</title>
<style>
  :root { --bg:#f8fafc; --card:#fff; --line:#e2e8f0; --text:#0f172a; --muted:#64748b; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.7 system-ui,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin:16px 0; }
  .status { display:flex; align-items:center; gap:16px; }
  .light { width:56px; height:56px; border-radius:50%; flex:none; }
  .ok .light { background:#22c55e; } .caution .light { background:#facc15; } .danger .light { background:#ef4444; }
  .status h2 { margin:0; font-size:22px; }
  .status p { margin:4px 0 0; color:var(--muted); }
  .counts { display:flex; gap:12px; margin-top:12px; flex-wrap:wrap; }
  .counts span { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:4px 12px; font-size:13px; }
  .alert { border-left:4px solid #ef4444; padding:12px 16px; margin:12px 0; background:#fef2f2; border-radius:0 8px 8px 0; }
  .alert.warn { border-left-color:#f59e0b; background:#fffbeb; }
  .alert h3 { margin:0 0 4px; font-size:16px; }
  .alert .meta { color:var(--muted); font-size:12px; }
  .alert dl { margin:8px 0 0; }
  .alert dt { font-weight:600; font-size:13px; margin-top:6px; }
  .alert dd { margin:0; font-size:14px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  td.detail { color:var(--muted); word-break:break-all; }
  #setup input { width:100%; padding:8px; border:1px solid var(--line); border-radius:8px; margin:4px 0 12px; }
  button { padding:8px 20px; border:0; border-radius:8px; background:var(--text); color:#fff; cursor:pointer; }
  .hidden { display:none; }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <h1>chrome-EDR ダッシュボード</h1>

  <div id="setup" class="card">
    <p>テナントAPIキーを入力してください（この端末のブラウザにのみ保存されます）。</p>
    <input id="apiKey" type="password" placeholder="テナントAPIキー" />
    <button id="connect">表示する</button>
    <p id="setupError" class="muted"></p>
  </div>

  <div id="main" class="hidden">
    <div id="statusCard" class="card status ok">
      <div class="light"></div>
      <div>
        <h2 id="statusTitle">確認中...</h2>
        <p id="statusDesc"></p>
        <div class="counts" id="counts"></div>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size:17px;margin-top:0">要対応のアラート</h2>
      <p class="muted" style="font-size:13px">それぞれ「何が起きたか」「なぜ危険か」「次にすべきこと」を確認してください。</p>
      <div id="alerts"></div>
    </div>

    <div class="card">
      <h2 style="font-size:17px;margin-top:0">最近のイベント</h2>
      <table><thead><tr><th>時刻</th><th>種類</th><th>端末</th><th>内容</th></tr></thead>
      <tbody id="events"></tbody></table>
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const api = (path, key) => fetch(path, { headers: { Authorization: "Bearer " + key } }).then((r) => {
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
});

const STATUS_TEXT = {
  ok:      ["問題なし", "この24時間、対応が必要な問題は見つかっていません。"],
  caution: ["注意", "確認したほうがよい出来事があります。下のアラートを確認してください。"],
  danger:  ["危険", "対応が必要な問題が起きています。下のアラートの「次にすべきこと」に従ってください。"],
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function describeEvent(ev) {
  const p = ev.payload || {};
  if (ev.type === "nav.completed") return p.host || "";
  if (ev.type === "ai.visit") return "生成AIサイトを利用: " + (p.host || "");
  if (ev.type === "ai.paste") return "生成AIへ貼り付け (" + p.chars + "文字): " + (p.host || "");
  if (ev.type === "download.created") return "ダウンロード: " + (p.filename || p.url || "");
  if (ev.type.startsWith("extension.")) return (p.name || p.id || "") + " (拡張機能)";
  if (ev.type.startsWith("alert.")) return p.title || "";
  return JSON.stringify(p).slice(0, 80);
}

async function load(key) {
  const [sum, alerts, events] = await Promise.all([
    api("/v1/summary", key),
    api("/v1/alerts?limit=20", key),
    api("/v1/events?limit=30", key),
  ]);

  const card = $("statusCard");
  card.className = "card status " + sum.status;
  $("statusTitle").textContent = STATUS_TEXT[sum.status][0];
  $("statusDesc").textContent = STATUS_TEXT[sum.status][1];
  $("counts").innerHTML =
    '<span>24時間のイベント: ' + (sum.bySeverity.info + sum.bySeverity.warn + sum.bySeverity.critical) + '件</span>' +
    '<span>注意: ' + sum.bySeverity.warn + '件</span>' +
    '<span>危険: ' + sum.bySeverity.critical + '件</span>';

  $("alerts").innerHTML = alerts.events.length === 0
    ? '<p class="muted">アラートはありません。</p>'
    : alerts.events.map((ev) => {
        const p = ev.payload || {};
        return '<div class="alert ' + (ev.severity === "warn" ? "warn" : "") + '">' +
          '<h3>' + esc(p.title || ev.type) + '</h3>' +
          '<div class="meta">' + new Date(ev.ts).toLocaleString() + ' / 端末: ' + esc(ev.device_id) + '</div>' +
          '<dl>' +
          '<dt>何が起きた?</dt><dd>' + esc(p.whatHappened || "-") + '</dd>' +
          '<dt>なぜ危険?</dt><dd>' + esc(p.whyRisky || "-") + '</dd>' +
          '<dt>次にすべきこと</dt><dd>' + esc(p.nextAction || "-") + '</dd>' +
          '</dl></div>';
      }).join("");

  $("events").innerHTML = events.events.map((ev) =>
    '<tr><td>' + new Date(ev.ts).toLocaleTimeString() + '</td><td>' + esc(ev.type) + '</td>' +
    '<td>' + esc(ev.device_id) + '</td><td class="detail">' + esc(describeEvent(ev)) + '</td></tr>'
  ).join("");
}

async function connect(key) {
  try {
    await load(key);
    try { localStorage.setItem("edrApiKey", key); } catch {}
    $("setup").classList.add("hidden");
    $("main").classList.remove("hidden");
  } catch (e) {
    $("setupError").textContent = "接続できませんでした: " + e.message;
  }
}

$("connect").addEventListener("click", () => connect($("apiKey").value.trim()));
let saved = null;
try { saved = localStorage.getItem("edrApiKey"); } catch {}
if (saved) connect(saved);
</script>
</body>
</html>`;
