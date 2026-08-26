# chrome-EDR

**ブラウザネイティブなOSSのEDR（Endpoint Detection & Response）— Chrome拡張 + Cloudflare Workers**

> Browser-native, open-source EDR for businesses. Chrome extension agent + self-hostable Cloudflare Workers backend.

従来のEDRはOSプロセスは見えてもブラウザの中（DOM・拡張機能・SaaS操作）は見えない。SWG/プロキシはTLSの外からしか見えない。chrome-EDR は **ブラウザの内側** にエージェント（Chrome拡張）を置き、テレメトリ収集・脅威検知・対応をオープンソースかつセルフホスト可能な形で提供する。

## アーキテクチャ

```
┌─────────────────────┐        ┌──────────────────────────────┐
│ Chrome (従業員端末)  │        │ Cloudflare (セルフホスト可)    │
│ ┌─────────────────┐ │ HTTPS  │ ┌─────────┐   ┌────────────┐ │
│ │ 拡張機能エージェント│─┼────────┼→│ Workers │──→│ D1 (SQLite)│ │
│ │ ・テレメトリ収集   │ │ ingest │ │ ingest  │   └────────────┘ │
│ │ ・ローカル検知     │ │        │ │ API     │   ┌────────────┐ │
│ │ ・ポリシー適用     │ │        │ └─────────┘──→│ ダッシュボード│ │
│ └─────────────────┘ │        │               └────────────┘ │
└─────────────────────┘        └──────────────────────────────┘
```

- **agent/** — Chrome拡張 (Manifest V3)。ナビゲーション・ダウンロード・拡張機能の変化などを監視し、イベントをバッチ送信
- **worker/** — Cloudflare Workers。イベント取り込みAPI + D1永続化 + 管理ダッシュボード

## 開発プロセス（ハッカソンMVP）

半日ハッカソンで、スプリント＝GitHubマイルストーンとしてPDCAを回す。各スプリントの成果は常に「動く最小単位」。

| Sprint | ゴール |
|---|---|
| 1 | 拡張機能スケルトン＋テレメトリ収集（ローカルで確認できる） |
| 2 | Workers取り込みAPI＋D1永続化（イベントがサーバに届く） |
| 3 | 検知ルールエンジン＋アラート（脅威が検知される） |
| 4 | ダッシュボード＋セルフホスト手順（他人が使える） |

進行状況は [Milestones](../../milestones) と [Issues](../../issues) を参照。

## クイックスタート（開発）

```bash
# 拡張機能: chrome://extensions → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ agent/ を選択

# バックエンド (ローカル)
cd worker
npm install
npm run dev
```

## ライセンス

MIT License — see [LICENSE](LICENSE)
