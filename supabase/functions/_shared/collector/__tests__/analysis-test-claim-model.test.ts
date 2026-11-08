// Models what the DATABASE does when the analysis queue is claimed, instead of only returning extra rows from a stub.
//
// Ground truth (proved against the real SQL in supabase/tests/20_claim_pending.test.sql):
//   dr_claim_pending_records(p_limit) is a read-only SELECT. It returns at most least(greatest(p_limit,1),200) pending rows,
//   oldest first, and it neither updates nor locks anything. The only state change in a pass is dr_mark_skipped / dr_save_signals
//   on the rows the app then chooses to process; the only "in progress" marker is the self-expiring 'analysis' job lock.
//
// So: (1) SqlFaithfulStore reproduces that behaviour, and the tests prove analysis_test mutates at most 10 rows;
//     (2) ClaimingDbStore models a HYPOTHETICAL future migration that really claims rows, as a canary: a database that
//         over-claims cannot be contained by application code, and the mutation-budget check below is what would flag it;
//     (3) interruption tests prove a failed or hard-killed pass leaves no record in limbo and the lock frees itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisTest } from '../runner.ts';
import { MemoryStore, rec, silentLog } from './helpers.ts';
import type { PendingRecord } from '../ai.ts';

const worth = (id: string) => rec('github', id);
const notWorth = (id: string) => rec('github', id, { title: `release ${id}`, excerpt: `Version ${id} was released today.` });

// ---- mutation accounting -------------------------------------------------------------------------------------------------
type Snap = Map<string, string>;
/** Everything stored about each record (its row and its signal), serialised per record id. */
function snap(s: MemoryStore): Snap {
  const m: Snap = new Map();
  for (const r of s.records.values()) m.set(r.id, JSON.stringify({ row: r, signal: s.signals.get(r.id) ?? null }));
  return m;
}
function changed(before: Snap, after: Snap): string[] {
  const out: string[] = [];
  for (const [id, v] of after) if (before.get(id) !== v) out.push(id);
  return out;
}
/** The invariant analysis_test is meant to guarantee: no more than `budget` records are mutated by one invocation. */
function assertMutationBudget(before: Snap, after: Snap, budget: number) {
  const n = changed(before, after).length;
  assert.ok(n <= budget, `database mutated ${n} records, budget is ${budget}`);
}

// ---- model 1: the real SQL ------------------------------------------------------------------------------------------------
class SqlFaithfulStore extends MemoryStore {
  /** Buggy-backend switch: ignore the limit and return every pending row (still read-only, like a mis-written SELECT). */
  overReturn = false;
  claimLog: Array<{ asked: number; returned: number; mutatedDuringCall: number }> = [];
  async claimPending(limit: number): Promise<PendingRecord[]> {
    const before = snap(this);
    const n = this.overReturn ? Infinity : Math.min(Math.max(limit ?? 1, 1), 200); // least(greatest(p_limit, 1), 200); NULL -> 1
    const rows = (await super.claimPending(Number.MAX_SAFE_INTEGER)).slice(0, n); // pending only, oldest first, NO writes
    this.claimLog.push({ asked: limit, returned: rows.length, mutatedDuringCall: changed(before, snap(this)).length });
    return rows;
  }
}

// ---- model 2: a hypothetical DB that really claims rows (does NOT exist today) -------------------------------------------
class ClaimingDbStore extends MemoryStore {
  constructor(private markFactor: number) { super(); } // 1 = honours the limit, 3 = marks 3x as many rows as it was asked for
  claimLog: Array<{ asked: number; marked: number; returned: number }> = [];
  async claimPending(limit: number): Promise<PendingRecord[]> {
    const n = Math.min(Math.max(limit ?? 1, 1), 200);
    const pending = [...this.records.values()].filter((r) => r.status === 'pending');
    const marked = pending.slice(0, n * this.markFactor);
    marked.forEach((r) => { (r as any).status = 'claimed'; }); // DB-side mutation at claim time
    const rows = marked.slice(0, n).map((r) => ({ id: r.id, source_id: r.source_id, kind: r.kind, title: r.title, excerpt: r.excerpt, categories: r.categories, engagement: r.engagement, content_hash: r.content_hash, language: r.language }));
    this.claimLog.push({ asked: limit, marked: marked.length, returned: rows.length });
    return rows;
  }
}

async function seed<T extends MemoryStore>(store: T, specs: Array<(id: string) => any>) {
  await store.upsertRecords(specs.map((mk, i) => mk(`m${i}`)));
  return store;
}
const many = (n: number, mk = worth) => Array.from({ length: n }, () => mk);

// ---- 1. the SQL model itself behaves like dr_claim_pending_records ----------------------------------------------------------
test('SQL model: claimPending(10) is read-only and returns the 10 oldest pending rows', async () => {
  const store = await seed(new SqlFaithfulStore(), many(250));
  const before = snap(store);
  const rows = await store.claimPending(10);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.id), [...store.records.values()].slice(0, 10).map((r) => r.id));
  assert.deepEqual(changed(before, snap(store)), [], 'a claim call must not change any stored row');
  assert.equal((await store.claimPending(10)).map((r) => r.id).join(), rows.map((r) => r.id).join(), 'peek semantics: repeat call returns the same rows');
});

test('SQL model: limit is clamped to [1, 200] exactly like least(greatest(p_limit, 1), 200)', async () => {
  const store = await seed(new SqlFaithfulStore(), many(250));
  for (const [asked, want] of [[10, 10], [1, 1], [0, 1], [-5, 1], [200, 200], [201, 200], [1_000_000, 200]] as const) {
    assert.equal((await store.claimPending(asked)).length, want, `claimPending(${asked})`);
  }
  assert.ok(store.claimLog.every((c) => c.mutatedDuringCall === 0));
});

// ---- 2. analysis_test against the SQL model: the real guarantee -------------------------------------------------------------
test('analysis_test vs the real-SQL model: exactly one claim of <=10, zero mutations at claim time, <=10 rows mutated in total, the rest byte-identical', async () => {
  const store = await seed(new SqlFaithfulStore(), [...many(7), ...many(3, notWorth), ...many(30)]);
  const before = snap(store);
  const rep = await runAnalysisTest({ store, log: silentLog });
  const after = snap(store);

  assert.equal(store.claimLog.length, 1, 'one bounded claim, never a loop');
  assert.ok(store.claimLog[0].asked <= 10 && store.claimLog[0].returned <= 10, JSON.stringify(store.claimLog[0]));
  assert.equal(store.claimLog[0].mutatedDuringCall, 0, 'the claim itself writes nothing');

  const mutated = changed(before, after);
  assertMutationBudget(before, after, 10);
  assert.equal(mutated.length, rep.analysed + rep.skipped, 'every mutated row is one the pass analysed or skipped');
  const firstTen = new Set([...store.records.values()].slice(0, 10).map((r) => r.id));
  assert.ok(mutated.every((id) => firstTen.has(id)), 'only the 10 oldest rows can have been touched');
  for (const r of [...store.records.values()].slice(10)) assert.equal(after.get(r.id), before.get(r.id), `row ${r.id} beyond the cap must be untouched`);
  assert.equal(store.signals.size, rep.analysed);
});

test('analysis_test vs a DB that OVER-RETURNS (reads far more than asked, still read-only): the app truncates, so DB mutations stay <= 10', async () => {
  const store = new SqlFaithfulStore();
  store.overReturn = true;
  await seed(store, many(40));
  const before = snap(store);
  const rep = await runAnalysisTest({ store, log: silentLog });
  assert.equal(store.claimLog[0].returned, 40, 'precondition: the backend really did hand back all 40 rows');
  assert.equal(rep.claimed, 10);
  assertMutationBudget(before, snap(store), 10);
  assert.equal(changed(before, snap(store)).length, 10);
  assert.equal([...store.records.values()].filter((r) => r.status === 'pending').length, 30, 'the other 30 rows were never written');
});

// ---- 3. canary: what a CLAIMING database would mean (not today's behaviour) ----------------------------------------------
test('canary: if the DB were a real claim that honours the limit, analysis_test would still mark <=10 rows (the request is capped)', async () => {
  const store = await seed(new ClaimingDbStore(1), many(40));
  const before = snap(store);
  await runAnalysisTest({ store, log: silentLog });
  assert.equal(store.claimLog.length, 1);
  assert.ok(store.claimLog[0].asked <= 10);
  assert.equal(store.claimLog[0].marked, 10);
  assertMutationBudget(before, snap(store), 10);
  assert.equal([...store.records.values()].filter((r) => (r.status as string) === 'claimed').length, 0, 'every claimed row was resolved (done/skipped), none left in a claimed state');
});

test('canary: a DB that OVER-CLAIMS server-side (marks 3x the limit) cannot be contained by the app; the mutation budget check flags it', async () => {
  const store = await seed(new ClaimingDbStore(3), many(40));
  const before = snap(store);
  await runAnalysisTest({ store, log: silentLog });
  assert.ok(store.claimLog[0].asked <= 10, 'the app asked for <=10: the fault is entirely database-side');
  assert.equal(store.claimLog[0].marked, 30, 'precondition: the faulty DB marked 30 rows');
  assert.throws(() => assertMutationBudget(before, snap(store), 10), /database mutated \d+ records, budget is 10/);
  // 20 rows stay stuck in 'claimed' forever: this is the failure supabase/tests/20_claim_pending.test.sql exists to prevent
  assert.equal([...store.records.values()].filter((r) => (r.status as string) === 'claimed').length, 20);
});

// ---- 4. interruption -----------------------------------------------------------------------------------------------------
class FlakyStore extends MemoryStore {
  failSave = false;
  async saveSignals(ss: Parameters<MemoryStore['saveSignals']>[0]) { if (this.failSave) throw new Error('connection reset'); return super.saveSignals(ss); }
}

test('interrupted pass (store throws mid-pass): the error surfaces, the lock is released, no record is in limbo, no attempt is burned', async () => {
  const store = await seed(new FlakyStore(), [...many(7), ...many(3, notWorth), ...many(20)]);
  store.failSave = true;
  await assert.rejects(() => runAnalysisTest({ store, log: silentLog }), /connection reset/);
  assert.equal(store.locks.has('analysis'), false, 'finally{} released the lock');
  for (const r of store.records.values()) {
    assert.ok(['pending', 'skipped'].includes(r.status), `record ${r.id} is ${r.status}`); // skipped = committed by its own call before the failure
    assert.equal(r.attempts, 0, 'markFailed is unreachable in test mode, so attempts never move');
  }
  assert.equal([...store.records.values()].filter((r) => r.status === 'skipped').length, 3);
  assert.equal(store.signals.size, 0);
});

/** A job lock with a real TTL and an injectable clock. releaseLock can be suppressed to model a process killed before finally{}. */
class TtlLockStore extends FlakyStore {
  nowMs = 0; ttlsAsked: Array<number | undefined> = []; killBeforeRelease = false;
  private until = new Map<string, number>();
  async acquireLock(name: string, seconds?: number) {
    this.ttlsAsked.push(seconds);
    if ((this.until.get(name) ?? 0) > this.nowMs) return false;
    this.until.set(name, this.nowMs + (seconds ?? 0) * 1000);
    return true;
  }
  async releaseLock(name: string) { if (!this.killBeforeRelease) this.until.set(name, this.nowMs - 1); }
}

test('hard-killed pass (never reaches releaseLock): nothing is stranded, the lock blocks other passes for <=180s, then the queue is usable again', async () => {
  const store = await seed(new TtlLockStore(), [...many(7), ...many(3, notWorth), ...many(20)]);
  store.failSave = true; store.killBeforeRelease = true;
  await assert.rejects(() => runAnalysisTest({ store, log: silentLog }));
  assert.deepEqual(store.ttlsAsked, [180], 'the test action takes the lock for 180s, so a crash can block analysis for at most 3 minutes');
  assert.ok([...store.records.values()].every((r) => ['pending', 'skipped'].includes(r.status) && r.attempts === 0), 'no limbo state after the kill');

  // 60s later another pass (normal cron or a second test call) is refused, claims nothing, and says why
  store.nowMs = 60_000; store.failSave = false;
  const blocked = await runAnalysisTest({ store, log: silentLog });
  assert.equal(blocked.ran, false);
  assert.equal(blocked.claimed, 0);
  assert.match(blocked.note ?? '', /interrupted/);

  // after the TTL it heals itself with no manual cleanup, and the cap still holds
  store.nowMs = 181_000;
  store.killBeforeRelease = false;
  const before = snap(store);
  const healed = await runAnalysisTest({ store, log: silentLog });
  assert.equal(healed.ran, true);
  assert.ok(healed.claimed >= 1 && healed.claimed <= 10);
  assertMutationBudget(before, snap(store), 10);
});
