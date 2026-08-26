# chrome-EDR

**ブラウザネイティブなOSSのEDR（Endpoint Detection & Response）— Chrome拡張 + Cloudflare Workers**

> Browser-native, open-source EDR for businesses. Chrome extension agent + self-hostable Cloudflare Workers backend.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sudolifeagain/chrome-EDR)

従来のEDRはOSプロセスは見えてもブラウザの中（DOM・拡張機能・SaaS操作）は見えない。SWG/プロキシはTLSの外からしか見えない。chrome-EDR は **ブラウザの内側** にエージェント（Chrome拡張）を置き、テレメトリ収集・脅威検知・対応をオープンソースかつセルフホスト可能な形で提供する。

## プロダクトの意義

1. **セキュリティに疎い人でもわかるEDR** — アラートは専門用語を並べない。「何が起きたか」「なぜ危険か」「次に何をすべきか」を平易な日本語で提示し、専任のセキュリティ担当がいない組織でも運用できる。
2. **いま起きている脅威への対応（シャドーAI対策など）** — 生成AIサイトの利用可視化、業務データの大量ペースト検知、危険な拡張機能のインストール検知など、従来型EDRの死角かつ直近に問題化している事象を最初のターゲットにする。
3. **OSSでセルフホスト可能** — 既存の商用ブラウザセキュリティ製品は全てクローズドSaaS。テレメトリを自組織のCloudflareアカウントから出さずに運用できる。

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
# バックエンド (ローカル)
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run db:local   # ローカルD1にスキーマ適用
npm run dev        # http://localhost:8787 で起動（トップページがダッシュボード）
```

拡張機能は chrome://extensions → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ `agent/` を選択。テナント作成とキー設定の手順は [docs/self-host.md](docs/self-host.md) を参照。

## ドキュメント

- [docs/self-host.md](docs/self-host.md) — 自組織のCloudflareアカウントへのデプロイ手順
- [docs/architecture.md](docs/architecture.md) — D1分散シャーディング設計とコスト最適化
- [docs/market-research.md](docs/market-research.md) — 競合13製品の比較と差別化戦略
- [docs/scrum.md](docs/scrum.md) — 開発プロセスとふりかえりログ

## ライセンス

MIT License — see [LICENSE](LICENSE)
