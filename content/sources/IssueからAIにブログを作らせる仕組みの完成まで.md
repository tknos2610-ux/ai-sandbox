# IssueからAIにブログを作らせる仕組みの完成まで

2026-11-21 · 開発記録

iPhoneと無料枠だけで、GitHubのIssueに書いた指示からAIにページを作らせ、GitHub Pagesで公開する仕組みを作りました。前回の記事のあと、ワークフローを何度も直して、今は「作る指示は main に反映、質問はIssueへ回答」まで動く形にしています。この記事は、その流れとつまずいた点のまとめです。

## 今の仕組み

- 指示を書く場所: GitHubのIssue(iPhoneのSafariから)
- AI: OpenHandsのresolver(0.62.0に固定)を、GitHub Actionsで動かす
- モデル: Geminiの無料APIキー(Variablesの LLM\_MODEL に gemini/ に続けてモデル名)
- 公開: GitHub Pages(main ブランチの直下)
- 起動: Issueに fix-me ラベルを付ける、または @openhands-agent とコメントする

リポジトリはPublicなので、パスワードやAPIキー、個人情報は置きません。

## 直したところ

### 1. PRではなく、main に直接反映

最初はAIがPRを作る形でした。成功したときは変更を main にそのまま反映し、作業のまとめをIssueに書き込む形に変えました。失敗したときは main に触れず、試した内容を作業用ブランチに残します。AIが書いた内容がレビューなしで公開されるので、重要なページには向きません。

### 2. 毎回インストールされる

GitHub Actionsは毎回新しい環境で動くため、OpenHandsも毎回インストールされます。キャッシュで短くできますが、環境そのものを保存しておくことはできません。

### 3. 何も出力されないとき

「エラーなく終わったのに、Issueにも main にも何も出ない」ことがありました。原因は2つでした。

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| Agent reached maximum iteration | AIが作業の回数の上限(20回)に達した | 変数 OPENHANDS\_MAX\_ITER を40にする。指示は小さく分ける |
| FileNotFoundError(日本語のファイル名) | 日本語のファイル名を、パッチ適用の処理が扱えない | ファイル名を半角英数字にする |
| ブランチ名が取れない | ログが標準エラーに出ていた | ログをまとめて取り込み、見つからなければブランチ一覧から探す |
| No changes to commit | 指示が「ブランチを整理して」で、ファイルの変更ではなかった | ブランチの削除は手作業で行う |

### 4. 質問にはIssueで答える

Issueに質問を書くと、AIはファイルを変えないので、「保存できる変更がありませんでした」と出て止まっていました。AIの最終メッセージを取り出し、Issueに「回答」として書き込むようにしました。あわせて、リポジトリ直下の .openhands\_instructions に、質問のときはファイルを変えず日本語で答える、と書いておきます。

なお、AIを実際に動かしての確認は、この記事の時点では済んでいません。

## 使い分けのコツ

- 作る・直す指示: 1つのIssueに1つのことだけ書く。ファイル名は半角英数字にする
- 質問: そのままIssueに書く。回答がコメントで返る
- リポジトリの操作(ブランチ削除など): AIには向かない。手作業で行う

## 注意点

- Geminiの無料枠は小さく、AIを呼ぶたびに消費します。無料枠で送った内容は、Googleの製品改善に使われることがあります。
- 無料枠の上限やサービスの提供状況は、変わることがあります。
- Julesは2026年12月末に終了し、11月11日以降は新しい作業ができません。

## 参考

- OpenHands resolver README (v0.62.0): https://github.com/OpenHands/OpenHands/blob/0.62.0/openhands/resolver/README.md
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- Jules 変更履歴: https://jules.google/docs/changelog
