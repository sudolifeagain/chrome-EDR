// chrome-EDR Agent - service worker
// テレメトリ収集: ナビゲーション / ダウンロード / 拡張機能の変化 / 生成AI利用
// 収集イベントはローカルの検知ルール(rules.js)で評価され、マッチするとアラートを生成する

import { evaluateRules, isAiHost, DEFAULT_POLICY } from "./rules.js";

const MAX_EVENTS = 500;
const MAX_OUTBOX = 2000;
const FLUSH_BATCH = 200;

// storage.local への読み書き競合を防ぐため書き込みを直列化する
let writeChain = Promise.resolve();

function serialized(fn) {
  writeChain = writeChain
    .then(fn)
    .catch((e) => console.error("chrome-EDR: storage op failed", e));
  return writeChain;
}

async function recordEvent(type, payload, severity = "info") {
  const policy = await getPolicy();
  const event = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    type,
    severity,
    payload,
  };
  // 検知ルール評価（アラート自身は再評価しない）
  const newEvents = [event];
  if (!type.startsWith("alert.")) {
    for (const alert of evaluateRules(event, policy)) {
      newEvents.push({
        id: crypto.randomUUID(),
        ts: Date.now(),
        type: `alert.${alert.ruleId}`,
        severity: alert.severity,
        payload: alert,
      });
      notifyAlert(alert, policy);
    }
  }

  return serialized(async () => {
    const { events = [], outbox = [] } = await chrome.storage.local.get([
      "events",
      "outbox",
    ]);
    // events: ポップアップ表示用リングバッファ / outbox: サーバ送信キュー
    events.push(...newEvents);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    outbox.push(...newEvents);
    if (outbox.length > MAX_OUTBOX) outbox.splice(0, outbox.length - MAX_OUTBOX);
    await chrome.storage.local.set({ events, outbox });
  });
}

// --- サーバへのバッチ送信 ---
// 1分間隔でまとめて送る: リクエスト数とD1課金クエリ数を抑えるための設計
chrome.alarms.create("edr-flush", { periodInMinutes: 1 });
chrome.alarms.create("edr-policy", { periodInMinutes: 5 });
fetchPolicy();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "edr-flush") flushOutbox();
  if (alarm.name === "edr-policy") fetchPolicy();
});

async function flushOutbox() {
  const { config, deviceId, outbox = [] } = await chrome.storage.local.get([
    "config",
    "deviceId",
    "outbox",
  ]);
  if (!config?.endpoint || !config?.apiKey || outbox.length === 0) return;

  const batch = outbox.slice(0, FLUSH_BATCH);
  try {
    const res = await fetch(`${config.endpoint.replace(/\/$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        device: {
          id: deviceId,
          agentVersion: chrome.runtime.getManifest().version,
        },
        events: batch,
      }),
    });
    if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status}`);
    // 送信成功分だけをoutboxから除去（送信中に追記された分は残す）
    const sentIds = new Set(batch.map((e) => e.id));
    await serialized(async () => {
      const { outbox: current = [] } = await chrome.storage.local.get("outbox");
      await chrome.storage.local.set({
        outbox: current.filter((e) => !sentIds.has(e.id)),
        lastFlush: { ts: Date.now(), sent: batch.length, ok: true },
      });
    });
  } catch (e) {
    // 失敗時はoutboxを保持したまま次のアラームでリトライ
    await chrome.storage.local.set({
      lastFlush: { ts: Date.now(), sent: 0, ok: false, error: String(e) },
    });
  }
}

async function ensureDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (!deviceId) {
    await chrome.storage.local.set({ deviceId: crypto.randomUUID() });
  }
}
ensureDeviceId();

// --- サーバ配信ポリシー ---
// 5分間隔で取得しstorageにキャッシュ。未設定・取得失敗時は既定ポリシーで動く
let policyCache = null;

async function getPolicy() {
  if (policyCache) return policyCache;
  const { serverPolicy } = await chrome.storage.local.get("serverPolicy");
  policyCache = { ...DEFAULT_POLICY, ...(serverPolicy ?? {}) };
  return policyCache;
}

async function fetchPolicy() {
  const { config } = await chrome.storage.local.get("config");
  if (!config?.endpoint || !config?.apiKey) return;
  try {
    const res = await fetch(`${config.endpoint.replace(/\/$/, "")}/v1/policy`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) return;
    const body = await res.json();
    if (body.policy) {
      await chrome.storage.local.set({ serverPolicy: body.policy });
      policyCache = { ...DEFAULT_POLICY, ...body.policy };
    }
  } catch (e) {
    console.warn("chrome-EDR: policy fetch failed", e);
  }
}

// --- デスクトップ通知（わかりやすさ: 平易な説明をそのまま通知する） ---
const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 };

function notifyAlert(alert, policy) {
  const level = policy.notify ?? "critical";
  if (level === "off") return;
  if (SEVERITY_RANK[alert.severity] < SEVERITY_RANK[level]) return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `chrome-EDR: ${alert.title}`,
    message: `${alert.whatHappened}\n次にすべきこと: ${alert.nextAction}`,
    priority: 2,
  });
}

// --- ナビゲーション（メインフレームの http/https のみ） ---
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  recordEvent("nav.completed", { url: details.url, host: url.hostname });
  // シャドーAI可視化: 生成AIサイトの利用を専用イベントとして記録
  // （ポリシーのaiHostsで対象を追加できる。訪問検知は全ホストを見るwebNavigationベース）
  const policy = await getPolicy();
  if (isAiHost(url.hostname, policy.aiHosts ?? [])) {
    recordEvent("ai.visit", { url: details.url, host: url.hostname });
  }
});

// --- content script (生成AIサイト) からのメッセージ ---
chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind === "ai.paste") {
    recordEvent("ai.paste", {
      host: String(message.host ?? ""),
      chars: Number(message.chars) || 0,
    });
  }
});

// --- ダウンロード ---
chrome.downloads.onCreated.addListener((item) => {
  recordEvent("download.created", {
    url: item.url,
    filename: item.filename,
    mime: item.mime,
  });
});

// --- 拡張機能の変化 ---
function extInfo(info) {
  return {
    id: info.id,
    name: info.name,
    version: info.version,
    installType: info.installType,
    permissions: info.permissions,
    hostPermissions: info.hostPermissions,
  };
}

chrome.management.onInstalled.addListener((info) =>
  recordEvent("extension.installed", extInfo(info))
);
chrome.management.onUninstalled.addListener((id) =>
  recordEvent("extension.uninstalled", { id })
);
chrome.management.onEnabled.addListener((info) =>
  recordEvent("extension.enabled", extInfo(info))
);
chrome.management.onDisabled.addListener((info) =>
  recordEvent("extension.disabled", extInfo(info))
);
