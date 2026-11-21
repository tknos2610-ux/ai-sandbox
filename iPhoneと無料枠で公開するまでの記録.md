# iPhoneと無料枠で公開するまでの記録

Nov 18, 2026 · @K

iPhoneと無料プランだけでは、Claudeの公開リンクも、リポジトリの作成も、Claude Codeも使えませんでした。確実に公開できるのは、GitHub Pagesに自分でHTMLを置く方法です。

## ここまでの疑問と結果

| 疑問 | 結果 |
| --- | --- |
| XやブログをiPhoneだけで集められるか | ブログはFeedlyやショートカットで集め、Claudeに貼れば要約できます。Xは公式APIの無料枠が小さいため、リストやブックマークから本文を自分でメモに集めます。 |
| Claudeのアーティファクトで公開できるか | 無料プランでは共有機能が含まれず、公開リンクは作れません。MarkdownやPDFなどで書き出すことはできます。 |
| GitHub Pagesで公開できるか | できます。完全無料で、iPhoneのSafariだけで済みます。 |
| ClaudeからGitHubにリポジトリを作れるか | できません。GitHub連携は、ファイル名とファイルの内容を読むだけの機能です。 |
| Claude Codeを無料で使えるか | 使えません。クラウド機能の対象は、Pro、Max、Teamなどの有料プランです。 |

## GitHub Pagesで公開する手順

1. SafariでGitHubの無料アカウントを作り、メール認証を済ませる
2. 右上の「+」から New repository を選び、Public にして作る。名前を ユーザー名.github.io にすると、URLが https://ユーザー名.github.io/ になる
3. Add file → Create new file で index.html を作り、HTMLを貼り付ける
4. Commit changes を2回押して保存する
5. Settings → Pages で、Source を Deploy from a branch、Branch を main の / (root) にして Save する。ボタンが見つからないときは、Safariで「デスクトップ用Webサイトを表示」にする
6. 1〜2分待つと、Pages画面の上にURLが出る

貼り付けるHTMLは、記事を元にClaudeに作ってもらえます。公開したページは誰でも見られるので、個人情報や他人の文章の全文は載せないでください。

## 参考

- [GitHub integration | Claude](https://claude.com/docs/connectors/github)
- [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web.md)
- [Claude Code overview](https://code.claude.com/docs/en/overview)
