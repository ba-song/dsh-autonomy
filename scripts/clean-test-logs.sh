#!/bin/sh
# 清理 2026-11-01/02T 与 1999-01-01T 测试 fixture 行；先备份，可重复执行。
set -eu
LOG_DIR=/sdcard/DSHA/生活/数据/logs
DELIVER=/sdcard/DSHA/生活/数据/home/deliver.log
AUTONOMY=$LOG_DIR/autonomy.log
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=$LOG_DIR/备份/clean-test-fixtures-$STAMP
mkdir -p "$BACKUP"

changed=0
for f in "$AUTONOMY" "$DELIVER"; do
  [ -f "$f" ] || continue
  n=$(grep -cE '2026-11-0[12]T|1999-01-01T' "$f" 2>/dev/null || true)
  [ -n "$n" ] || n=0
  [ "$n" -gt 0 ] || continue
  cp -p "$f" "$BACKUP/$(basename "$f").bak"
  tmp="$f.clean-$$"
  awk '!/2026-11-0[12]T/ && !/1999-01-01T/' "$f" > "$tmp"
  chmod --reference="$f" "$tmp" 2>/dev/null || true
  mv "$tmp" "$f"
  echo "cleaned $f: removed $n fixture lines"
  changed=1
done
if [ "$changed" -eq 0 ]; then
  echo "no 2026-11-01T fixture lines"
else
  echo "backup: $BACKUP"
fi
