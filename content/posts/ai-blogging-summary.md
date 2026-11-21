# AIとiPhoneで実現するブログ自動化と公開の記録

Nov 21, 2026 · @K

本記事では、GitHubのIssueとAI（OpenHandsおよびGemini）を活用してブログ記事を作成し、GitHub Pagesで公開する流れについて、これまでの検証結果をまとめてご紹介します。また、iPhoneと無料枠のみを活用して情報を収集・公開する方法についても併せて解説します。

---

## 1. AIを活用したブログ作成・公開サービスの比較

Issueに指示を出してAIにPull Requestを作らせるサービスについて、いくつかの選択肢を検証しました。

| サービス | 起動方法 | 無料での利用可否 | 結果・特徴 |
| --- | --- | --- | --- |
| Jules (Google) | Issueに「jules」ラベル | 無料枠あり | 12月31日で終了。11月11日以降は新規作業不可 |
| GitHub Copilot クラウドエージェント | IssueをCopilotに割り当て | 不可の見込み | 公式ページでは有料プラン向け |
| Claude Code (GitHub Actions) | 「@claude」とコメント | 不可 | Anthropic APIの従量課金が必要 |
| OpenAI Codex | 「@codex」とコメント | 不可の見込み | 無料のChatGPTにはクラウド機能なし |
| opencode | 「/opencode」とコメント | 本体は無料の見込み | Gemini無料キーでの動作は未確認 |
| OpenHands | 「fix-me」ラベル / コメント | 本体は無料 | **今回採用**。安定して動作 |

---

## 2. OpenHandsの設定手順

OpenHandsを用いてブログ記事やリポジトリの自動更新を行うための基本的な手順です。

1. リポジトリに `.github/workflows/openhands-resolver.yml` を配置する。
2. Settings → Actions → General → Workflow permissions で「Read and write permissions」を選び、「Allow GitHub Actions to create and approve pull requests」をオンにする。
3. Google AI StudioでGeminiのAPIキーを作成し、Settings → Secrets and variables → Actions の **Secrets** に `LLM_API_KEY` として登録する。
4. 同画面の **Variables** に `LLM_MODEL` を作成し、`gemini/` に続けてモデル名（例: `gemini/gemini-3.5-flash-lite`）を設定する。
5. Issues に `fix-me` ラベルを作成し、対象のIssueに付与するか `@openhands-agent` を含むコメントを投稿する。

---

## 3. iPhoneだけで情報を集めて公開する方法

パソコンを使わず、iPhoneと無料枠だけで情報を収集してブラウザで公開する手順です。

### 情報の収集
- **ブログ・ニュース**: RSS対応サイトをFeedlyやiOSの「ショートカット」アプリで購読し、Claudeに読み込ませて要約する。
- **X (Twitter)**: APIの無料枠制限が厳しいため、リストやブックマークから気になった投稿の本文やURLを「メモ」アプリに手動で集約する。

### 公開手段の選択
- Claudeのアーティファクト：無料プランでは共有機能（公開リンク作成）が利用できないため、Markdown等でエクスポートして活用する。
- **GitHub Pages**: SafariからGitHubリポジトリを作成し、HTMLファイルをアップロードすることで完全無料で自分専用のURLを持つことができる。

---

## 4. まとめ

AIエージェントやクラウドサービスを活用することで、アイデア出しから実装・ブログ記事の生成・公開までを効率的に行うことができます。用途やコストに合わせて適切なツールを選択していきましょう。
