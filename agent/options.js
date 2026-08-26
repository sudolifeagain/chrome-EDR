async function load() {
  const { config } = await chrome.storage.local.get("config");
  if (config) {
    document.getElementById("endpoint").value = config.endpoint || "";
    document.getElementById("apiKey").value = config.apiKey || "";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const config = {
    endpoint: document.getElementById("endpoint").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim(),
  };
  await chrome.storage.local.set({ config });
  const status = document.getElementById("status");
  status.textContent = "保存しました";
  setTimeout(() => (status.textContent = ""), 2000);
});

load();
