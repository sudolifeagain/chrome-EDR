// 検知ルールエンジン
// 各ルールは「セキュリティに疎い人でもわかる」説明を必ず持つ:
//   title / whatHappened(何が起きた) / whyRisky(なぜ危険) / nextAction(次にすべきこと)
// evaluate(event) がマッチすると { severity, details } を返し、アラートイベントが生成される

// 主要ブランドのタイポスクワット検知用リスト（登録可能ドメイン単位）
const PROTECTED_DOMAINS = [
  "google.com",
  "microsoft.com",
  "apple.com",
  "amazon.co.jp",
  "amazon.com",
  "rakuten.co.jp",
  "github.com",
  "paypal.com",
  "docomo.ne.jp",
  "smbc.co.jp",
  "mufg.jp",
];

// 生成AIサービスのドメイン（シャドーAI可視化対象）
export const AI_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "chat.deepseek.com",
  "perplexity.ai",
  "poe.com",
  "notebooklm.google.com",
];

// 既定ポリシー。サーバ配信のポリシー(GET /v1/policy)がこれに上書きマージされる
export const DEFAULT_POLICY = {
  notify: "critical", // デスクトップ通知するレベル: critical | warn | off
  aiHosts: [], // 追加の生成AIホスト（訪問可視化の対象に加算）
  rules: {
    "punycode-domain": { enabled: true },
    "lookalike-domain": { enabled: true, extraProtectedDomains: [] },
    "extension-installed": { enabled: true },
    "ai-mass-paste": { enabled: true, warnChars: 1000, criticalChars: 5000 },
  },
};

const DANGEROUS_PERMISSIONS = [
  "cookies",
  "webRequest",
  "history",
  "debugger",
  "proxy",
  "nativeMessaging",
  "management",
];

function editDistance1(a, b) {
  // 長さ差1以内・編集距離1（挿入/削除/置換）ならtrue
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return (
    a.slice(i + 1) === b.slice(i + 1) || // 置換
    a.slice(i + 1) === b.slice(i) || // aから1文字削除
    a.slice(i) === b.slice(i + 1) // aへ1文字挿入
  );
}

function registrableDomain(host) {
  // MVP簡易版: 末尾2〜3ラベル。co.jp/ne.jp等は3ラベル
  const parts = host.split(".");
  const secondLevel = parts[parts.length - 2];
  const take = ["co", "ne", "or", "ac", "go"].includes(secondLevel) ? 3 : 2;
  return parts.slice(-take).join(".");
}

export function isAiHost(host, extraHosts = []) {
  return [...AI_HOSTS, ...extraHosts].some(
    (h) => host === h || host.endsWith(`.${h}`)
  );
}

export const RULES = [
  {
    id: "punycode-domain",
    title: "偽装の可能性があるドメイン（Punycode）",
    whatHappened: "国際化ドメイン（xn--）を使ったサイトを開きました。",
    whyRisky:
      "本物そっくりの文字を使った偽サイト（フィッシング）でよく使われる手口です。",
    nextAction:
      "このサイトでID・パスワード・カード情報を入力しないでください。心当たりがなければタブを閉じてください。",
    evaluate(event) {
      if (event.type !== "nav.completed") return null;
      if (!event.payload.host?.includes("xn--")) return null;
      return { severity: "warn", details: { host: event.payload.host } };
    },
  },
  {
    id: "lookalike-domain",
    title: "有名サイトになりすました可能性のあるドメイン",
    whatHappened: "有名サービスとよく似た綴りのサイトを開きました。",
    whyRisky:
      "1文字だけ違うドメインは、ログイン情報を盗むための偽サイトの典型的な手口です。",
    nextAction:
      "アドレスバーの綴りを確認してください。ログインしてしまった場合は、本物のサイトでパスワードを変更してください。",
    evaluate(event, conf) {
      if (event.type !== "nav.completed" || !event.payload.host) return null;
      const domain = registrableDomain(event.payload.host);
      const protectedList = [
        ...PROTECTED_DOMAINS,
        ...(conf?.extraProtectedDomains ?? []),
      ];
      const target = protectedList.find((d) => editDistance1(domain, d));
      if (!target) return null;
      return {
        severity: "critical",
        details: { host: event.payload.host, similarTo: target },
      };
    },
  },
  {
    id: "extension-installed",
    title: "新しい拡張機能がインストールされました",
    whatHappened: "ブラウザに新しい拡張機能が追加されました。",
    whyRisky:
      "拡張機能は閲覧内容やログイン情報にアクセスできる場合があります。会社が許可していないものは情報漏えいの入り口になり得ます。",
    nextAction:
      "自分でインストールした覚えがあるか確認してください。覚えがなければ直ちに削除し、管理者に連絡してください。",
    evaluate(event) {
      if (event.type !== "extension.installed") return null;
      const p = event.payload;
      const broadHost = (p.hostPermissions ?? []).some(
        (h) => h === "<all_urls>" || h === "*://*/*"
      );
      const dangerous = (p.permissions ?? []).filter((x) =>
        DANGEROUS_PERMISSIONS.includes(x)
      );
      return {
        severity: broadHost || dangerous.length > 0 ? "critical" : "warn",
        details: {
          name: p.name,
          extensionId: p.id,
          broadHostAccess: broadHost,
          dangerousPermissions: dangerous,
        },
      };
    },
  },
  {
    id: "ai-mass-paste",
    title: "生成AIへの大量の貼り付け",
    whatHappened: "生成AIサイトに長いテキストが貼り付けられました。",
    whyRisky:
      "業務資料やソースコードをそのまま貼り付けると、社外のAIサービスに機密情報が渡ってしまう恐れがあります。",
    nextAction:
      "貼り付けた内容に社外秘・個人情報が含まれていないか確認してください。含まれていた場合は管理者に相談してください。",
    evaluate(event, conf) {
      if (event.type !== "ai.paste") return null;
      const warnChars = conf?.warnChars ?? 1000;
      const criticalChars = conf?.criticalChars ?? 5000;
      if ((event.payload.chars ?? 0) < warnChars) return null;
      return {
        severity: event.payload.chars >= criticalChars ? "critical" : "warn",
        details: { host: event.payload.host, chars: event.payload.chars },
      };
    },
  },
];

export function evaluateRules(event, policy = DEFAULT_POLICY) {
  const alerts = [];
  for (const rule of RULES) {
    // 既定 ← サーバ配信ポリシー の順でルール設定をマージ
    const conf = {
      ...DEFAULT_POLICY.rules[rule.id],
      ...(policy?.rules?.[rule.id] ?? {}),
    };
    if (conf.enabled === false) continue;
    let match = null;
    try {
      match = rule.evaluate(event, conf);
    } catch (e) {
      console.error(`chrome-EDR: rule ${rule.id} failed`, e);
    }
    if (match) {
      alerts.push({
        ruleId: rule.id,
        severity: match.severity,
        title: rule.title,
        whatHappened: rule.whatHappened,
        whyRisky: rule.whyRisky,
        nextAction: rule.nextAction,
        details: match.details,
        sourceEventId: event.id,
      });
    }
  }
  return alerts;
}
