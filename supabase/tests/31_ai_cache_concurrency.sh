#!/bin/bash
# Concurrency test for dr_ai_cache_begin: N independent database sessions race for the SAME cache identity.
# Exactly one may be told to compute ("claimed"); every other session must be told to wait ("busy"), so the model is called once.
# Usage: 31_ai_cache_concurrency.sh <database>   (psql connection settings come from the usual PG* environment variables)
# Run against a disposable database only. Pure SQL: no external service is called.
set -u
db=${1:?usage: $0 <database>}
N=${N:-12}
key=$(printf '%064d' "$RANDOM$RANDOM")      # 64 digits = a valid 64-char hex input hash
dir=$(mktemp -d)
for i in $(seq 1 "$N"); do
  ( psql -tAq -d "$db" -c "select public.dr_ai_cache_begin('decisions','$key','concurrency-test:free','v1',60)->>'state'" > "$dir/$i.out" 2> "$dir/$i.err" ) &
done
wait
claimed=$(cat "$dir"/*.out | grep -c '^claimed$')
busy=$(cat "$dir"/*.out | grep -c '^busy$')
errors=$(cat "$dir"/*.err | grep -c .)
psql -tAq -d "$db" -c "delete from public.dr_ai_cache where input_hash = '$key'" >/dev/null
rm -rf "$dir"
echo "sessions=$N claimed=$claimed busy=$busy errors=$errors"
if [ "$claimed" -eq 1 ] && [ "$busy" -eq $((N - 1)) ] && [ "$errors" -eq 0 ]; then
  echo "CACHE CONCURRENCY TEST PASSED"
else
  echo "CACHE CONCURRENCY TEST FAILED"; exit 1
fi
