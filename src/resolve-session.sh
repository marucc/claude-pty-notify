#!/bin/zsh
# -r に渡された名前から、同名の履歴のうち更新日時が最新のセッションIDを出力する
# UUID の指定・見つからない場合は何も出力せず 1 で終わる（呼び出し側は引数を変えない）
zmodload zsh/system
name="$1"
[[ -n "$name" ]] || exit 1
[[ "$name" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]] && exit 1

projects="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
# 履歴は数GBになるため、更新日時の新しい順に先頭だけを読み、最初に見つかった時点で終える
for file in "$projects"/*/*.jsonl(Nom); do
  exec {fd}<"$file" || continue
  sysread -i $fd -s 16384 head
  exec {fd}<&-
  if [[ "$head" == *'"customTitle":"'"$name"'"'* ]]; then
    print -r -- "${${file:t}%.jsonl}"
    exit 0
  fi
  head=
done
exit 1
