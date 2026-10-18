#!/usr/bin/env bash
# Prints the state of any openssl / identityProbe child older than 4 s.
seen=""
while true; do
  for pid in $(pgrep -f 'identityProbe.runner.ts|^openssl ' 2>/dev/null); do
    et=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$et" ] && [ "$et" -ge 4 ] || continue
    case " $seen " in *" $pid "*) continue ;; esac
    seen="$seen $pid"
    echo "=== HANG pid=$pid age=${et}s $(date -u +%T)"
    ps -o pid,ppid,stat,wchan:32,etimes,args -p "$pid"
    echo "--- status"; grep -E 'State|PPid|SigBlk|SigIgn|SigCgt' /proc/$pid/status
    echo "--- fds"; ls -l /proc/$pid/fd 2>&1 | head -20
    echo "--- stack"; sudo cat /proc/$pid/stack 2>&1 | head -20
    echo "--- children"; pgrep -P "$pid" | xargs -r ps -o pid,stat,wchan:32,args -p
    ppid=$(awk '/PPid/{print $2}' /proc/$pid/status)
    echo "--- parent $ppid"; ps -o pid,stat,wchan:32,etimes,nlwp -p "$ppid"
    echo "--- parent fds"; sudo ls -l /proc/$ppid/fd 2>&1 | wc -l
    echo "--- all bun/qm/npm/sleep processes"; ps -eo pid,ppid,stat,etimes,args --forest | grep -vE 'hangwatch|grep' | grep -E 'bun|qm|npm|node|sleep|openssl|sh ' | cut -c1-200 | head -40
    echo "--- top cpu"; ps -eo pid,pcpu,pmem,args --sort=-pcpu | head -8 | cut -c1-160
    free -m
  done
  sleep 1
done
