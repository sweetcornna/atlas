#!/usr/bin/env bash
# Temporary CI probe: every 15 s, the state of each `bun test` process and its
# children; any child older than 8 s is dumped once in detail.
seen=""
while true; do
  echo "=== $(date -u +%T) load=$(cut -d' ' -f1-3 /proc/loadavg) $(free -m | awk '/Mem/{print "used="$3" avail="$7}')"
  for b in $(pgrep -x bun); do
    grep -q -- '--isolate' /proc/$b/cmdline 2>/dev/null || continue
    echo "bun-test pid=$b fds=$(ls /proc/$b/fd 2>/dev/null | wc -l) thr=$(ls /proc/$b/task | wc -l) $(grep -E 'SigBlk|SigIgn|SigCgt' /proc/$b/status | tr '\n' ' ')"
    for c in $(pgrep -P "$b"); do
      et=$(ps -o etimes= -p "$c" | tr -d ' ')
      st=$(awk '{print $3}' /proc/$c/stat 2>/dev/null)
      echo "  child $c state=$st age=${et}s $(tr '\0' ' ' < /proc/$c/cmdline | cut -c1-120)"
      if [ "${et:-0}" -ge 8 ]; then
        case " $seen " in *" $c "*) continue ;; esac
        seen="$seen $c"
        echo "  --- detail $c"; grep -E 'State|SigBlk|SigIgn|SigCgt' /proc/$c/status | sed 's/^/    /'
        echo "    wchan=$(cat /proc/$c/wchan 2>/dev/null)"; sudo cat /proc/$c/stack 2>/dev/null | head -8 | sed 's/^/    /'
        ls -l /proc/$c/fd 2>/dev/null | head -8 | sed 's/^/    /'
        pgrep -P "$c" | xargs -r ps -o pid,stat,etimes,args -p | sed 's/^/    /'
      fi
    done
  done
  sleep 15
done
