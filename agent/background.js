// chrome-EDR Agent - service worker
// テレメトリ収集: ナビゲーション / ダウンロード / 拡張機能の変化

const MAX_EVENTS = 500;

// storage.local への読み書き競合を防ぐため書き込みを直列化する
let writeChain = Promise.resolve();

function recordEvent(type, payload, severity = "info") {
  writeChain = writeChain
    .then(async () => {
      const { events = [] } = await chrome.storage.local.get("events");
      events.push({
        id: crypto.randomUUID(),
        ts: Date.now(),
        type,
        severity,
        payload,
      });
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
      }
      await chrome.storage.local.set({ events });
    })
    .catch((e) => console.error("chrome-EDR: recordEvent failed", e));
  return writeChain;
}

async function ensureDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (!deviceId) {
    await chrome.storage.local.set({ deviceId: crypto.randomUUID() });
  }
}
ensureDeviceId();

// --- ナビゲーション（メインフレームの http/https のみ） ---
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  recordEvent("nav.completed", { url: details.url, host: url.hostname });
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
