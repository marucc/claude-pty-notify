# claude-pty-notify

[English](README.md) | 日本語

Claude Code を PTY でラップし、hooks を使わずに「入力待ち」をターミナル通知する。

管理者設定で hooks が無効化されている環境では、hooks ベースの通知（cmux の Claude 連携、Notification hook など）が動かない。claude-pty-notify は Claude Code が出力するターミナルタイトルと画面出力を監視するだけなので、hooks の有無に関係なく動く。

## 機能

- **入力待ち通知**: タイトルが `✳`（入力待ち）に変わったら OSC 777 で通知を送る。cmux / Ghostty などがデスクトップ通知として表示する。起動直後の `✳` と、すでに入力を始めている場合は通知しない
- **許可待ち・回答待ちの検知**: Claude Code が許可ダイアログ（"Do you want to ..."）や選択肢の質問（`AskUserQuestion`。"Chat about this" で検知）を出したら、タイトルを `▶` にして「許可待ち」「回答待ち」と通知する。タブで操作するまでマークは消えない（選択を動かすだけの矢印キーでは消えない）
- **未確認マーク**: まだ見ていない入力待ちは、非フォーカス中にタイトルを `✳` → `✦` に書き換える。タブにフォーカスすると `✳` に戻る
- **通知の抑制**: `~/.claude/no-notify-sessions` に書いたパターンに一致するセッションは通知しない
- **通知の言語**: ロケール（`LC_ALL` → `LC_MESSAGES` → `LANG` の順）から決める。英語と日本語を同梱。それ以外の言語は英語になる
- **入力ソケット**: 同じユーザーの別のプロセスが、`~/.claude/run/` の Unix ソケットを通して、セッションに文を入力したり状態を読んだりできる（[入力ソケット](#入力ソケット)を参照）
- **フォールバック**: 標準入出力が端末でないとき（パイプでの `claude -p` など）はラッパーを通さずに claude を実行する。`shim.sh` は、カレントディレクトリで解決される `node` が TypeScript を実行できないとき（mise で古い Node を固定しているプロジェクトなど）もラッパーなしで claude を起動する

## 必要なもの

- macOS
- Node.js 22.18 以上（TypeScript のソースをそのまま実行する）
- Claude Code（公式インストーラーで `~/.local/bin/claude` に導入済みであること）
- OSC 777 とフォーカスレポーティング（`\x1b[?1004h`）に対応したターミナル（cmux, Ghostty など）

## セットアップ

```bash
git clone https://github.com/marucc/claude-pty-notify.git
cd claude-pty-notify
./install.sh
```

依存パッケージのインストールと実行権限の付与を行う。シェルの設定ファイルは書き換えないので、表示された設定例を自分で追加する。

### cmux で使う

cmux はシェル統合で `claude` 関数を上書きするため、`.zshrc` に `claude` 関数を定義しても使われない。代わりに `CMUX_CUSTOM_CLAUDE_PATH` で `shim.sh` を指定する。

```zsh
export CMUX_CUSTOM_CLAUDE_PATH="/path/to/claude-pty-notify/shim.sh"
```

cmux が付与する `--settings` / `--mcp-config` はそのまま Claude Code に渡る。

### cmux 以外で使う

```zsh
claude() {
  if [[ -n "$CLAUDE_PTY_WRAPPED" ]]; then
    command claude "$@"
  else
    node /path/to/claude-pty-notify/src/wrapper.ts "$@"
  fi
}
```

## 通知の抑制

`~/.claude/no-notify-sessions` に 1 行 1 パターンで書く。セッション名（タイトルから `✳` を除いた部分）に部分一致・大文字小文字無視で一致したら通知しない。`#` で始まる行はコメント。

```
# 監視用のセッションは通知しない
monitor
```

環境変数 `CLAUDE_NO_NOTIFY=1` を付けて起動すると、そのセッションの通知をすべて止める。

## マークの変更

| 環境変数 | 状態 | デフォルト |
|---|---|---|
| `CLAUDE_PTY_UNREAD_MARKER` | 入力待ち（未確認） | `✦` |
| `CLAUDE_PTY_PERMISSION_MARKER` | 許可待ち・回答待ち | `▶` |

たとえば未確認マークを Nerd Font のベルにする場合（Nerd Font のアイコンは 1 文字分より広く描かれるので、後ろに空白を足す）:

```zsh
export CLAUDE_PTY_UNREAD_MARKER=$'\U000F009A '
```

## 言語の追加

`locales/en.json` と同じキーを持つ `locales/<言語>.json` を追加する。`{session}` はセッション名に置き換わる。

```json
{
  "waiting": "{session} 入力待ち",
  "permission": "{session} 許可待ち",
  "question": "{session} 回答待ち"
}
```

`pt_BR.UTF-8` の場合は `pt_BR.json` → `pt.json` → `en.json` の順に探す。全言語のファイルにキーが揃っているかは `npm test` で確認できる。

## 入力ソケット

対話のセッションは、`~/.claude/run/` に Unix ソケットを作る（ディレクトリは `0700`、ソケットは `0600`。macOS でだけ確認）。同じユーザーの別のプロセスが、これでセッションに文を入力したり、状態を読んだりできる。1接続で1要求・1応答、どちらも JSON 1行（16KiB まで）。要求のあとに書き込み側を閉じても応答は読める。応答の前の切断は検知しないので、まだ始まっていない `send` は接続の期限でだけ取り消される。

```jsonc
{"type":"info"}
// {"ok":true,"name":"pm","sessionId":null,"pid":123,"startedAt":"…","cwd":"…","title":"…","state":"waiting","dialogSuspected":false,"draftSuspected":false,"lastOutputAt":"…","lastInputAt":null}
{"type":"send","text":"/compact"}
// {"ok":true}  または  {"ok":false,"error":"blocked","reason":"dialog","retryable":true}
```

`state` は `starting`・`permission`・`question`・`waiting`・`working`。`send` は文をペースト（ブラケットペースト）して Enter を押す。許可・質問のダイアログが出ている疑いがあるときは `blocked`、ユーザーの下書き（入力欄に残った文字・ペースト・呼び出した履歴。Enter・Ctrl-C・Ctrl-U まで（Esc では下りない））があるか、直近（`CLAUDE_PTY_TYPING_GUARD_MS`、既定 3 秒）に入力したときは `user_typing`、最初のタイトルの前・待ちの種別を判定中・ブラケットペーストが無効のときは `not_ready` で断る。断りには `retryable` が付く。文を入力欄に入れた後の断りは `"reason":"pasted"` と `"pasted":true` が付き（`error` は断りの種類のまま）、再送してはいけない。文は入力欄に残り、ユーザーが片付けるまで、以後の送信は `user_typing` で断られる。そのほかのエラーは `bad_request`・`too_large`・`busy`（接続が上限を超えた。大きく超えると応答なしで切る）・`timeout`（要求の行は届いたが、期限内に送信が始まらなかった。要求の行が期限内に届かない接続は応答なしで切る）・`not_ready` で reason が `internal`（想定外の失敗。再送不可）。`info` の `title` は先頭のマークを除いた文字列で、最初のタイトルの前は `null`。`lastInputAt` は端末から入力した答えだけを数え、矢印キーや端末の応答は数えない。

文は 1〜4000 文字で、制御文字（タブと改行は可）・書式文字を含まず、空白・`!`・`#` で始まらず、`\` で終わらず、`exit`・`quit`・`:q`・`:q!`・`:wq`・`:wq!` だけの文でもない（claude が `/exit` として実行する。前後の空白と大文字小文字は無視して比べる）。先頭が `/` の文は、`session-init`・`status-sync`・`compact`・`clear`・`ping` だけ許可する（1行のみ。足すときは `CLAUDE_PTY_ALLOWED_COMMANDS`）。

限界: ダイアログとして認識するのは、許可ダイアログと質問だけ。選択メニュー（`/config`・`/model` など）・plan 承認・trust folder は認識しないので、開いている間の `send` が項目を選んでしまうことがある。ユーザーが最後に入力してから `CLAUDE_PTY_DIALOG_HOLD_MS` がたつと、ダイアログは閉じたと見なす。ファイルやコマンドの候補が出ているときの Enter は、送信でなく候補の確定になることがある。Ctrl-U は複数行の下書きの現在行しか消さない。

ソケットの名前は `-n` / `--name`（末尾の ` [ハッシュ]` を除く）、無ければ `pid-<pid>.sock`。セッションの突き合わせは、ファイル名ではなく `info` の `name`・`sessionId`・`cwd` で行う（`sessionId` は起動時の引数 `--resume` / `-r` / `--session-id` に渡した UUID で、これらが無ければ `null`。`-r` に渡した名前は、先に `shim.sh` が UUID に置き換える。`/clear` や `--fork-session` で ID が変わっても更新されない）。`-p` / `--print` のとき、標準入出力が端末でないとき、安全に作れないとき（stderr に警告を出す）は作らない。強制終了したラッパーの古いソケットは、起動時に片付く。

| 変数 | 意味 | 既定 |
|---|---|---|
| `CLAUDE_PTY_NO_INPUT` | `1` でソケットを作らない | |
| `CLAUDE_PTY_RUN_DIR` | ソケットのディレクトリ | `~/.claude/run` |
| `CLAUDE_PTY_ALLOWED_COMMANDS` | 追加で許可するスラッシュコマンド（カンマ区切り） | |
| `CLAUDE_PTY_TYPING_GUARD_MS` | ユーザーの入力からこの時間は送信を断る（1000〜60000） | `3000` |
| `CLAUDE_PTY_DIALOG_HOLD_MS` | タイトルが変わらずにダイアログに答えた後（最後の入力かダイアログの出力から数える）、開いていると見なす時間（5000〜600000） | `30000` |
| `CLAUDE_PTY_MAX_CONNECTIONS` | 同時の接続数（1〜32） | `8` |
| `CLAUDE_PTY_CONNECTION_TIMEOUT_MS` | 要求の1行を受け取るまでの期限と、受け取ってから送信を始めるまでの期限（それぞれ。始めた送信は必ず完了する）（1000〜60000） | `5000` |

これらの変数は Claude には引き継がない。同じユーザーのどのプロセスでも送信できる（これ以上の認証は無い）。Claude 自身（ツールは同じユーザーで動く）もソケットに届く。

## デバッグ

```bash
CLAUDE_PTY_DEBUG=1 claude               # stderr にログを出す
CLAUDE_PTY_LOG=/path/to/pty.log claude  # ファイルにログを出す
```

## 開発

```bash
npm ci             # typescript と @types/node も入る
npm test           # node --test test/*.test.ts
npm run typecheck  # tsc（出力なし）
```

## 制限

- 許可待ちは許可ダイアログの文言（"Do you want to ..."）で検知している。Claude Code の文言が変わると入力待ち扱いになる。タイトルが `✳` に変わった後の出力だけを見るので、Claude の返答そのものは誤検知しない
- 選択肢の質問は "Chat about this" の選択肢で検知している。Claude Code の文言が変わると入力待ち扱いになる
- Claude Code のタイトル表示の仕様が変わると動かなくなる

## ライセンス

MIT
