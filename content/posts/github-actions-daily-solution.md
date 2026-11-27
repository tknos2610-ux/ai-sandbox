# GitHub Actionsで毎日Pythonを自動実行したい：取得して保存するまでの設定（解決編）

Nov 27, 2026 · @K

問題編では、GitHub Actionsで毎日Pythonを動かすときの注意点をまとめました。解決編では、それを踏まえた実際の設定を紹介します。最後は「毎日ネットから情報を取ってきて、GitHubに保存する」ところまで作ります。

---

## 基本：毎日決まった時間にPythonを実行する

リポジトリに `.github/workflows/daily.yml` というファイルを作り、次の内容を書きます。日本時間の朝9時に `main.py` を実行する例です。

```yaml
name: daily-run
on:
  schedule:
    - cron: "0 0 * * *"   # UTC 0:00 = 日本時間 9:00
  workflow_dispatch:       # 手動実行ボタンも付ける

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt   # 必要な場合のみ
      - run: python main.py
```

ポイントは次のとおりです。

- `cron` は **UTC** で書く。日本時間から9時間引く
- `workflow_dispatch` を入れておくと、Actions画面から手動で実行できる。毎朝を待たずに動作確認できて便利
- ファイルは **デフォルトブランチ（main）** に置く

---

## 応用：ネットから取得してGitHubに保存する

Pythonで情報を取ってきてファイルに書き出し、ワークフローの中でcommitとpushをします。

```yaml
name: daily-fetch
on:
  schedule:
    - cron: "0 0 * * *"   # 日本時間 9:00
  workflow_dispatch:

permissions:
  contents: write          # pushに必要

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install requests
      - run: python fetch.py   # 例: data/2026-11-26.json などに保存
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/
          git diff --cached --quiet || git commit -m "daily update $(date +%F)"
          git push
```

問題編の注意点に、それぞれ次のように対応しています。

| 注意点 | 対応 |
| --- | --- |
| pushで失敗する | `permissions: contents: write` で書き込み権限を与える |
| 変更がない日にエラーになる | `git diff --cached --quiet \|\|` で、変更があるときだけcommitする |
| 公開リポジトリは60日放置で止まる | 毎日commitが入るので、放置扱いにならない |

---

## APIキーはSecretsに入れる

APIキーが必要な場合は、コードに書かずに **Secrets** を使います。

1. リポジトリの Settings → Secrets and variables → Actions を開く
2. 「New repository secret」でキーを登録する（例：`API_KEY`）
3. ワークフローで環境変数として渡す

```yaml
      - run: python fetch.py
        env:
          API_KEY: ${{ secrets.API_KEY }}
```

Python側では `os.environ["API_KEY"]` で読み取ります。Secretsの値はログにも伏せ字で表示されます。

---

## 無料枠に収めるコツ

- **ランナーは `ubuntu-latest`（Linux）を使う**：WindowsやmacOSは無料分を早く消費する
- **1日1回・数分の処理なら余裕**：1回3分なら月90分程度で、非公開リポジトリの月2,000分（Freeプラン）に十分収まる
- **公開してよい内容なら公開リポジトリにする**：標準のランナーなら実行時間は無料

---

## 取得先への配慮

- 公式のAPIがあるサービスは、APIを使う
- 利用規約で自動取得が禁止されているサイトからは取らない
- 1日1回など、アクセスは必要最小限にする

---

## まとめ

- `schedule` と cron（UTC）で、毎日決まった時間にPythonを実行できる
- `workflow_dispatch` で手動実行も付けておくと確認が楽
- 保存は `permissions: contents: write` と、変更があるときだけcommitする書き方で
- APIキーはSecretsに入れて、環境変数で渡す
- 1日1回程度なら、非公開リポジトリでも無料枠に収まる

次は、取ってきたデータをGitHub Pagesで見られるようにしてみます。
