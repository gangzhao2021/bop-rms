#!/bin/sh
# WP-2423 (2026-11-02): read-only samples for a pilot restart window, once a second, from the host:
# per-process CPU time, memory and open database connections; connections per role; what `/` answers.
# Start it before the restart and stop it after. It changes nothing and prints no data values.
#   sh tooling/environment/pilot-restart-measure.sh <output.tsv> [seconds] [origin-url]
# Env: PILOT_CONTAINER, POSTGRES_CONTAINER, POSTGRES_USER, POSTGRES_PORT, POSTGRES_DB.
set -u
out=${1:?output file}
seconds=${2:-420}
origin=${3:-}
pilot=${PILOT_CONTAINER:-bop-rms-pilot-pilot-1}
postgres=${POSTGRES_CONTAINER:-bop-rms-pilot-postgres-1}
pg_user=${POSTGRES_USER:-bop_rms_wp2402_v4_admin}
pg_port=${POSTGRES_PORT:-55435}
pg_db=${POSTGRES_DB:-bop_rms_pilot_v15}
# One line per process: name, directory, elapsed seconds, CPU seconds, peak and current RSS (MB),
# database connections. Sockets are matched by inode against connections to the database port.
processes='
hex=$(printf "%04X" "'"$pg_port"'")
inodes=$(awk -v p=":$hex" "\$3 ~ p && \$4 == \"01\" {print \$10}" /proc/net/tcp | tr "\n" " ")
for dir in /proc/[0-9]*; do
  [ -r "$dir/cmdline" ] || continue
  cmd=$(tr "\0" " " <"$dir/cmdline")
  case "$cmd" in *tooling/environment/pilot-*.mjs*) ;; *) continue ;; esac
  name=$(echo "$cmd" | sed -E "s#.*tooling/environment/pilot-([a-z-]+)\.mjs ?(.*)#\1 \2#;s#\.local/[^/ ]*/?##")
  conns=0
  for fd in "$dir"/fd/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    case "$link" in socket:*) i=${link#socket:[}; i=${i%]}; case " $inodes " in *" $i "*) conns=$((conns+1));; esac;; esac
  done
  set -- $(cut -d" " -f14,15,22 "$dir/stat" 2>/dev/null)
  hwm=$(awk "/VmHWM/{print int(\$2/1024)}" "$dir/status" 2>/dev/null)
  rss=$(awk "/VmRSS/{print int(\$2/1024)}" "$dir/status" 2>/dev/null)
  echo "process|$name|$(( ($1+$2)/100 ))|$hwm|$rss|$conns"
done'
end=$(( $(date +%s) + seconds ))
: >"$out"
while [ "$(date +%s)" -lt "$end" ]; do
  at=$(date -u +%H:%M:%S)
  docker exec "$postgres" psql -U "$pg_user" -p "$pg_port" -d "$pg_db" -At -F'|' -c \
    "SET default_transaction_read_only=on; SELECT 'role',usename,state,count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename IS NOT NULL GROUP BY 2,3" 2>/dev/null \
    | grep '^role' | sed "s/^/$at|/" >>"$out"
  docker exec "$pilot" sh -c "$processes" 2>/dev/null | sed "s/^/$at|/" >>"$out"
  # Stall from memory and swap left on the machine (it stops the processes above, whatever the CPU).
  docker exec "$pilot" sh -c 'echo "memory|$(sed -n 2p /proc/pressure/memory | cut -d" " -f2)|$(awk "/MemAvailable/{print int(\$2/1024)}/SwapFree/{print int(\$2/1024)}" /proc/meminfo | tr "\n" "|")"' 2>/dev/null | sed "s/^/$at|/" >>"$out"
  if [ -n "$origin" ]; then
    code=$(curl -k -s -o /dev/null -m 2 -w '%{http_code}' "$origin/" 2>/dev/null)
    echo "$at|http|$code" >>"$out"
  fi
  sleep 1
done
echo "--- peak connections per role"
awk -F'|' '$2=="role"{k=$1 FS $3; n[k]+=$5} END{for(k in n){split(k,a,FS); if(n[k]>m[a[2]])m[a[2]]=n[k]} for(r in m)print r,m[r]}' "$out"
echo "--- memory: worst full-stall avg10, lowest available MB, lowest swap free MB"
awk -F'|' '$2=="memory"{split($3,a,"="); if(a[2]>s)s=a[2]; if(m==""||$4<m)m=$4; if(w==""||$5<w)w=$5} END{print s,m,w}' "$out"
echo "--- per process: peak rss MB, last cpu s, peak connections"
awk -F'|' '$2=="process"{if($5>h[$3])h[$3]=$5; c[$3]=$4; if($7>d[$3])d[$3]=$7} END{for(p in h)print p,h[p],c[p],d[p]}' "$out" | sort
if [ -n "$origin" ]; then echo "--- / status by second"; awk -F'|' '$2=="http"{print $1,$3}' "$out" | uniq -f1; fi
