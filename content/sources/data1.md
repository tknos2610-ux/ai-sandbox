# IssueからAIでブログを作り公開する記録

Nov 20, 2026 · @K

GitHubのIssueに指示を書き、AIにブログ記事を作らせて、GitHub Pagesで公開する流れを、無料の範囲で試しました。OpenHandsとGeminiのAPIキーの組み合わせで、AIがindex.htmlをブランチに作るところまで進んでいます。

## AIサービスの比較

Issueに指示を書いてAIにPRを作らせるサービスは、無料で使えて、確認も取れたものが多くありません。

| サービス | 起動方法 | 無料で使えるか | 結果 |
| --- | --- | --- | --- |
| Jules(Google) | Issueに「jules」ラベル | 無料枠はあった | 12月31日に終了。11月11日以降は新しい作業ができない |
| GitHub Copilotのクラウドエージェント | IssueをCopilotに割り当てる | 使えない見込み | 公式ページでは有料プラン向け |
| Claude Code(GitHub Actions) | 「@claude」とコメント | 使えない | Anthropic APIの従量課金が必要 |
| OpenAI Codex | 「@codex」とコメント | 使えない見込み | 無料のChatGPTにはクラウド機能がない |
| opencode | 「/opencode」とコメント | 本体は無料の見込み | Geminiの無料キーで使えるかは未確認 |
| OpenHands | 「fix-me」ラベル | 本体は無料 | 今回はこれを採用 |

## OpenHandsの設定手順

OpenHandsの公式サンプルは、現在のmainに存在しない共通ワークフローを呼び出します。リゾルバは2025年11月の版(0.62.0)に残っていたので、その版に固定した自己完結型のファイルを作りました。このファイルは、動作を試す前のものです。

1. リポジトリに `.github/workflows/openhands-resolver.yml` を作り、ワークフローを貼り付けて Commit changes を押す
2. Settings → Actions → General → Workflow permissions で、Read and write permissions を選び、「Allow GitHub Actions to create and approve pull requests」をオンにして Save する
3. Google AI StudioでGeminiのAPIキーを作り、Settings → Secrets and variables → Actions の **Secrets** に `LLM_API_KEY` として登録する
4. 同じ画面の **Variables** に `LLM_MODEL` を作り、`gemini/` に続けてモデル名を入れる
5. Issues → Labels で `fix-me` というラベルを作る
6. Issueを作って、ラベル `fix-me` を付ける。または「@openhands-agent」から始まるコメントを書く

成功するとドラフトのPRができて、Issueにコメントが付きます。失敗すると、試した内容を入れたブランチができます。

アクションの実行中に「この依頼でAIを呼ぶ回数」の上限は、既定で 20 回にしました。Geminiの無料枠が小さいためです。Variablesに `OPENHANDS_MAX_ITER` を作ると変更できます。

## つまずいた点と対処

| 出たメッセージ | 意味 | 対処 |
| --- | --- | --- |
| repository variable LLM\_MODEL is not set | モデル名の変数が空で、アクションが開始直後に止まった | Secretsではなく**Variables**に `LLM_MODEL` を作り、ラベルを付け直す |
| Node.js 20 is deprecated | 部品が古いNode.js向けで、新しい版で動かされているという警告 | エラーではないので、無視してよい |
| Your main branch isn't protected | mainブランチが保護されていないというお知らせ | 1人で使うテスト用リポジトリなら、保護せずにマージしてよい |

## モデルの選び方

`gemini-3.5-flash-lite` はGoogleの公式モデル一覧で、今も安定版です。`LLM_MODEL` には、各行のIDの前に `gemini/` を付けて入力します。廃止された `gemini-3.5-flash` と `gemini-3.7-flash` は、それぞれ3.6と3.8に自動で振り替えられます。

| モデルID | 状態 | 無料枠 | 特徴 | 有料価格(100万トークン) |
| --- | --- | --- | --- | --- |
| gemini-3.5-flash-lite | 安定版 | 第三者の記事では対象 | 3.5世代で最速・最安。大量処理向け | 未確認 |
| gemini-3.1-flash-lite | 安定版 | 公式で確認 | 低コストで高い性能とされる | 入力0.25ドル、出力1.50ドル |
| gemini-3.6-flash | 安定版 | 第三者の記事では対象 | 速度とマルチモーダルのバランス型 | 未確認 |
| gemini-3.8-flash | 安定版 | 第三者の記事では対象 | 最も高性能なFlash。長い作業のコーディング向け | 未確認 |
| gemini-3-flash-preview | プレビュー版 | 公式で確認 | 低コストで先端級の性能とされる | 入力0.50ドル、出力3.00ドル |

無料枠の回数は、Googleが数値を公開していません。第三者の報告では、Flashが1日20回前後、Flash-Liteが1日500回前後でした。品質を上げると、回数が足りなくなる可能性があります。公式ページには、性能を数字で比べる点数は載っていませんでした。

試す順番は、まず `gemini/gemini-3.5-flash-lite`、だめなら `gemini/gemini-3.1-flash-lite`、品質が低いときは `gemini/gemini-3.8-flash` です。

## ブランチのindex.htmlを公開する手順

AIがブランチに作ったindex.htmlを、mainに取り込んでから公開します。

1. Issueのコメントにあるブランチのリンクを開き、index.htmlの中身と、ファイルがリポジトリの一番上にあることを確認する
2. Contribute → Open pull request を選び、Create pull request を押す
3. Merge pull request → Confirm merge で、mainに取り込む
4. Settings → Pages で、Source を Deploy from a branch、Branch を main、フォルダを / (root) にして Save する
5. 1〜2分待つと、Pages画面の上にURLが表示される

URLは、リポジトリ名を ユーザー名.github.io にした場合は `https://ユーザー名.github.io/`、それ以外は `https://ユーザー名.github.io/リポジトリ名/` です。公開したページは誰でも見られるので、個人情報や機密は載せないでください。設定画面が見つからないときは、Safariの「デスクトップ用Webサイトを表示」にします。

## 次にやること

- 公開したURLを開き、ブログテストのページが表示されるか確認する。公開までの結果は、この記事の時点では未確認です
- Issueを増やして、記事のテーマや簡単なアプリを依頼してみる。作るものを1つに絞り、ファイル名と置き場所を指定する
- 無料枠の上限に当たったときは、モデルをFlash-Lite系に戻すか、依頼の回数を減らす
- OpenHandsの版は1年前のものなので、新しいモデル名を受け付けない場合は、Actionsのログで原因を確かめる
- Geminiの無料枠で送った内容は、Googleの製品改善に使われることがある。機密情報は書かない

## 参考

- [Jules 変更履歴(公式)](https://jules.google/docs/changelog)
- [OpenHands GitHub Action](https://docs.all-hands.dev/usage/how-to/github-action)
- [OpenHands resolver README (v0.62.0)](https://github.com/OpenHands/OpenHands/blob/0.62.0/openhands/resolver/README.md)
- [opencode GitHub integration](https://opencode.ai/docs/github/)
- [Copilot cloud agent (GitHub Docs)](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-a-pr)
- [Gemini models(公式)](https://ai.google.dev/gemini-api/docs/models)
- [Gemini API pricing(公式)](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API release notes(公式)](https://ai.google.dev/gemini-api/docs/changelog)
- [Gemini API Free Tier in 2026(第三者)](https://www.aifreeapi.com/en/posts/google-gemini-api-free-tier)
- [OpenAI Codex free access, explained(第三者)](https://www.eesel.ai/blog/openai-codex-free-access-explained)
