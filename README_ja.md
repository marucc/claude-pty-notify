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
