#!/usr/bin/env bash
# Temporary CI probe: when a child of `bun test` stays a zombie for 2 s, dump
# once how bun-test watches it (pidfds, epoll registrations, thread stacks).
declare -A first
dumped=0
while true; do
  for b in $(pgrep -x bun); do
    grep -q -- '--isolate' /proc/$b/cmdline 2>/dev/null || continue
    for c in $(pgrep -P "$b"); do
      st=$(awk '{print $3}' /proc/$c/stat 2>/dev/null)
      [ "$st" = Z ] || { unset "first[$c]"; continue; }
      now=$(date +%s)
      [ -n "${first[$c]}" ] || first[$c]=$now
      [ $((now - first[$c])) -ge 2 ] || continue
      [ "$dumped" -lt 3 ] || continue
      dumped=$((dumped + 1)); first[$c]=999999999999
      echo "=== $(date -u +%T.%N) zombie $c of bun-test $b (dump $dumped)"
      for fd in /proc/$b/fd/*; do
        l=$(readlink "$fd"); n=${fd##*/}
        case "$l" in
          *pidfd*) echo "  fd $n $l $(grep -E '^Pid' /proc/$b/fdinfo/$n | tr '\n' ' ')" ;;
          *eventpoll*) echo "  fd $n $l"; grep -E '^tfd' /proc/$b/fdinfo/$n | sed 's/^/      /' ;;
        esac
      done
      for t in /proc/$b/task/*; do
        echo "  task ${t##*/} $(cat $t/comm) $(awk '{print $3}' $t/stat) wchan=$(cat $t/wchan)"
        sudo cat $t/stack 2>/dev/null | head -6 | sed 's/^/      /'
      done
      if [ "$dumped" -eq 1 ] && command -v gdb >/dev/null; then
        timeout 60 sudo gdb -p "$b" -batch -ex 'set pagination off' -ex 'thread apply all bt 25' 2>&1 | grep -vE '^\[New LWP|^warning' | head -400 | sed 's/^/    gdb| /'
      fi
    done
  done
  sleep 1
done
