function describe(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case "nav.completed":
      return p.url;
    case "download.created":
      return `${p.filename || "(不明)"} ← ${p.url}`;
    case "extension.installed":
    case "extension.enabled":
    case "extension.disabled":
      return `${p.name} (${p.id})`;
    case "extension.uninstalled":
      return p.id;
    default:
      return JSON.stringify(p);
  }
}

async function render() {
  const { events = [] } = await chrome.storage.local.get("events");
  document.getElementById("count").textContent = `${events.length} events`;

  const list = document.getElementById("list");
  list.textContent = "";

  if (events.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "イベントはまだありません。閲覧すると記録されます。";
    list.appendChild(li);
    return;
  }

  for (const ev of events.slice(-100).reverse()) {
    const li = document.createElement("li");
    li.className = `sev-${ev.severity}`;

    const type = document.createElement("span");
    type.className = "type";
    type.textContent = ev.type;

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date(ev.ts).toLocaleTimeString();

    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = describe(ev);

    li.append(type, ts, detail);
    list.appendChild(li);
  }
}

render();
