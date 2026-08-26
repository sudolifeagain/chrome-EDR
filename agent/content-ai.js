// 生成AIサイト用 content script（シャドーAI対策）
// プライバシー配慮: 貼り付けた本文は一切収集しない。文字数と貼り付け先ホストのみを記録する。

document.addEventListener(
  "paste",
  (e) => {
    try {
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.length === 0) return;
      chrome.runtime.sendMessage({
        kind: "ai.paste",
        host: location.hostname,
        chars: text.length,
      });
    } catch {
      // 拡張のリロード直後などでコンテキストが無効な場合は無視
    }
  },
  true
);
