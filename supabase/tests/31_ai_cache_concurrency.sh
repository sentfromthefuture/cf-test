#!/bin/bash
# Concurrency tests for the dr_ai_cache lease: N independent database sessions race for the SAME cache identity.
#   1. claim race     exactly one session may be told to compute ("claimed"); every other one must be told to wait ("busy").
#   2. takeover race  when a holder's lease has expired, exactly one session takes over, with a NEWER fencing epoch.
#   3. fencing        a burst of stale-holder complete/fail/fail_storage/abandon calls, from many sessions at once, must change nothing; the new
#                     holder's lease survives and its result is the one that is stored - even when stale calls race it.
# Usage: 31_ai_cache_concurrency.sh <database>   (psql connection settings come from the usual PG* environment variables)
# Run against a disposable database only. Pure SQL: no external service is called.
set -u
db=${1:?usage: $0 <database>}
N=${N:-12}
dir=$(mktemp -d)
fail=0
q() { psql -tAq -F ' ' -d "$db" -c "$1"; }
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($2)"; else echo "  FAIL $1: expected '$3' got '$2'"; fail=1; fi; }
newkey() { printf '%064d' "$RANDOM$RANDOM$RANDOM"; }   # 64 digits = a valid 64-char hex input hash
begin_sql() { echo "select x->>'state' || ' ' || coalesce(x->>'epoch','-') from (select public.dr_ai_cache_begin('decisions','$1','concurrency-test:free','v1',60) as x) t"; }

# ------------------------------------------------------------------ 1. claim race
echo "1. claim race ($N sessions, one identity)"
key=$(newkey)
for i in $(seq 1 "$N"); do ( q "$(begin_sql "$key")" > "$dir/c$i.out" 2> "$dir/c$i.err" ) & done
wait
claimed=$(cat "$dir"/c*.out | grep -c '^claimed ')
busy=$(cat "$dir"/c*.out | grep -c '^busy ')
errors=$(cat "$dir"/c*.err | grep -c .)
echo "  sessions=$N claimed=$claimed busy=$busy errors=$errors"
check "exactly one claim" "$claimed" 1
check "everyone else told to wait" "$busy" $((N - 1))
check "no errors" "$errors" 0
q "delete from public.dr_ai_cache where input_hash = '$key'" > /dev/null

# ------------------------------------------------------------------ 2. takeover race
echo "2. takeover race (holder A's lease expired, $N sessions race to replace it)"
key=$(newkey)
read -r stateA epochA < <(q "$(begin_sql "$key")")
idA=$(q "select id from public.dr_ai_cache where input_hash = '$key'")
check "A holds the lease" "$stateA" claimed
q "update public.dr_ai_cache set lease_until = now() - interval '1 second' where id = '$idA'" > /dev/null
for i in $(seq 1 "$N"); do ( q "$(begin_sql "$key")" > "$dir/t$i.out" 2> "$dir/t$i.err" ) & done
wait
claimed=$(cat "$dir"/t*.out | grep -c '^claimed ')
busy=$(cat "$dir"/t*.out | grep -c '^busy ')
epochB=$(cat "$dir"/t*.out | grep '^claimed ' | awk '{print $2}')
echo "  claimed=$claimed busy=$busy A's epoch=$epochA B's epoch=$epochB"
check "exactly one takeover" "$claimed" 1
check "the rest told to wait" "$busy" $((N - 1))
check "the new holder has a NEWER epoch" "$([ -n "$epochB" ] && [ "$epochB" -gt "$epochA" ] && echo yes || echo no)" yes

# ------------------------------------------------------------------ 3. fencing under concurrency
echo "3a. stale burst: $N sessions act as the expired worker A (complete / fail / fail_storage / abandon with A's old epoch)"
for i in $(seq 1 "$N"); do
  case $((i % 4)) in
    0) sql="select public.dr_ai_cache_complete('$idA', $epochA, '{\"from\":\"stale-$i\"}'::jsonb)" ;;
    1) sql="select public.dr_ai_cache_fail('$idA', $epochA, 'stale-$i')" ;;
    2) sql="select 'abandon-called' from (select public.dr_ai_cache_abandon('$idA', $epochA)) t" ;;
    3) sql="select public.dr_ai_cache_fail_storage('$idA', $epochA, 'stale-$i')" ;;
  esac
  ( q "$sql" > "$dir/s$i.out" 2> "$dir/s$i.err" ) &
done
wait
accepted=$(cat "$dir"/s*.out | grep -c '^t$')
echo "  stale complete/fail operations accepted: $accepted"
check "no stale complete/fail was accepted" "$accepted" 0
check "no errors" "$(cat "$dir"/s*.err | grep -c .)" 0
read -r st ep fa res < <(q "select status, lease_epoch, failed_attempts, coalesce(result::text,'null') from public.dr_ai_cache where id = '$idA'")
check "the new holder's lease is untouched (still pending)" "$st" pending
check "its epoch is unchanged" "$ep" "$epochB"
check "no failure was recorded against it" "$fa" 0
check "no STORAGE failure or engine-level backoff was recorded either" "$(q "select (select storage_failures from public.dr_ai_cache where id = '$idA') + (select count(*) from public.dr_ai_health where model = 'concurrency-test:free')")" 0
check "no result was stored by a stale worker" "$res" null

echo "3b. the current holder completes while $N stale sessions race it"
for i in $(seq 1 "$N"); do ( q "select public.dr_ai_cache_complete('$idA', $epochA, '{\"from\":\"stale-$i\"}'::jsonb)" > "$dir/r$i.out" 2> "$dir/r$i.err" ) & done
( q "select public.dr_ai_cache_complete('$idA', $epochB, '{\"from\":\"holder\"}'::jsonb)" > "$dir/holder.out" 2> "$dir/holder.err" ) &
wait
check "the current holder's completion was accepted" "$(cat "$dir/holder.out")" t
check "every racing stale completion was refused" "$(cat "$dir"/r*.out | grep -c '^t$')" 0
read -r st res < <(q "select status, result->>'from' from public.dr_ai_cache where id = '$idA'")
check "entry is succeeded" "$st" succeeded
check "the stored result is the current holder's" "$res" holder

q "delete from public.dr_ai_cache where id = '$idA'" > /dev/null
rm -rf "$dir"
if [ "$fail" -eq 0 ]; then
  echo "CACHE CONCURRENCY TEST PASSED"
else
  echo "CACHE CONCURRENCY TEST FAILED"; exit 1
fi
