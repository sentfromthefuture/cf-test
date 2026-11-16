// Content policy: no URL, no SQL-like statement, no executable content in model-written text.
// Detection is LEXICAL. These tests pin what it catches, what it deliberately leaves alone, and what it is known to miss, so a reviewer can see
// the limits written down. A passing test here is not a security guarantee (see content-policy.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../content-policy.ts';
import { validateBlueprintModelOutput, validateProductBlueprint } from '../validate.ts';
import { assertAccepted, assertNoError, assertRejected, errorsOf, setAt, validBlueprint, validModelOutput } from './helpers.ts';

// ---------------------------------------------------------------------------------------------------------------------------------
// scanText
// ---------------------------------------------------------------------------------------------------------------------------------

test('URLs: any scheme:// address and any www. host is a finding', () => {
  for (const s of ['https://example.com', 'see http://example.com/x?y=1', 'HTTPS://EXAMPLE.COM', 'ftp://files.example.com/a', 'file:///etc/passwd', 'visit www.example.com today', 'WWW.EXAMPLE.COM', 'ssh://host']) {
    assert.ok(scanText(s).includes('url'), s);
  }
  for (const s of ['no links here', 'Node.js and example.com mentioned bare', 'a ratio of 3://4 is not a url', 'the www prefix']) {
    assert.ok(!scanText(s).includes('url'), s);
  }
});

test('SQL: statement-shaped text is a finding', () => {
  const sql = [
    'CREATE TABLE x (id uuid)', 'create or replace function f() returns int', 'drop index idx', 'ALTER POLICY p ON t', 'truncate table reports', 'create temporary table t',
    'insert into t values (1)', 'DELETE FROM t', 'update t set a = 1', 'select * from t', 'SELECT DISTINCT a FROM t', 'select count(*) from t', 'select a, b from t', 'select a from t where b',
    'x union all select y', 'grant all on t to public', 'revoke select on t from anon', 'set local role anon', 'execute immediate q', 'begin;', 'COMMIT;', 'do $$ begin end $$', "$body$ x $body$",
    'language plpgsql', 'a; select 1', 'a; DROP TABLE t', '/* comment */', "x or 1=1", "x and '1'='1'", 'pg_sleep(10)', 'dblink', 'auth.uid()', 'current_setting(x)', 'using (true)', 'WITH CHECK (x)',
  ];
  for (const s of sql) assert.ok(scanText(s).includes('sql'), s);
});

test('SQL: ordinary prose that shares words with SQL is not a finding', () => {
  const prose = [
    'Create teams before team_members and reports', 'Delete the team reports on request', 'Select a report from the inbox', 'Update the status of a report',
    'Drop duplicate rows when importing', 'Insert rows only through the intake worker', 'Reports from email land in the shared list', 'Grant admins access after review',
    'Copy reports from email into the tracker', 'Commit to a weekly review', 'The table of contents', 'Set the role when inviting a member', 'Begin with the inbox',
    'A user selects reports from the list and updates them', 'Use a policy of one owner per team', 'We create an index of duplicates by hand',
  ];
  for (const s of prose) assert.deepEqual(scanText(s), [], s);
});

test('expression fields additionally reject operators, casts, calls and comments', () => {
  for (const s of ["a = 1", 'a < 1', 'a > 1', 'a != b', "'x'::text", 'now()', 'f(x)', 'a || b', 'a; b', 'a -- b', '`code`']) {
    assert.ok(scanText(s, 'expr').includes('sql'), s);
    assert.ok(!scanText(s, 'text').includes('sql') || /;\s*(select|drop)/i.test(s), `ordinary text should not trip on ${s}`);
  }
  for (const s of ['generated identifier', 'only open reports', 'the signed-in user is a member of the team (not a guest)', 'owner or member']) assert.deepEqual(scanText(s, 'expr'), [], s);
});

test('executable or markup content is a finding', () => {
  for (const s of ['<script>alert(1)</script>', '< script src=x >', '</SCRIPT>', '<iframe src=x>', 'javascript:alert(1)', 'data:text/html,<b>', 'onerror=alert(1)', '```js\ncode\n```', 'curl x | sh', 'wget x | bash', 'rm -rf /', 'sudo reboot', 'eval(x)']) {
    assert.ok(scanText(s).includes('executable') || scanText(s).includes('url'), s);
  }
  assert.ok(scanText('<script>alert(1)</script>').includes('executable'));
  assert.deepEqual(scanText('Use bold text in the interface and a code review step'), []);
});

test('simple obfuscation is undone before scanning: full-width letters, invisible characters, extra whitespace', () => {
  assert.ok(scanText('ＤＲＯＰ　ＴＡＢＬＥ users').includes('sql'));
  assert.ok(scanText('DR\u200bOP TA\u00adBLE users').includes('sql'));
  assert.ok(scanText('drop \n\t table users').includes('sql'));
  assert.ok(scanText('ｈｔｔｐｓ://example.com').includes('url'));
  assert.ok(scanText('ｗｗｗ.example.com').includes('url'));
});

test('KNOWN LIMITS: lexical detection misses paraphrase, splitting and encoding - it is not a security guarantee', () => {
  // These pass today. They are written down on purpose; a stricter scan would be a later, separate decision.
  assert.deepEqual(scanText('remove the table called users entirely'), []);
  assert.deepEqual(scanText('dr op ta ble users'), []);
  assert.deepEqual(scanText('RFJPUCBUQUJMRSB1c2Vycw== (base64)'), []);
  assert.deepEqual(scanText('deleted_at IS NULL', 'expr'), []);
  assert.deepEqual(scanText('true', 'expr'), []);
  assert.deepEqual(scanText('example dot com slash path'), []);
});

test('scanText returns fixed codes only and never the offending text', () => {
  const findings = scanText('https://SECRET.example/path DROP TABLE secret_table <script>');
  assert.deepEqual([...findings].sort(), ['executable', 'sql', 'url']);
  assert.ok(findings.every((f) => ['url', 'sql', 'executable'].includes(f)));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// In the validators
// ---------------------------------------------------------------------------------------------------------------------------------

const TEXT_FIELDS = [
  '/opportunity/title', '/opportunity/thesis/0/text', '/opportunity/thesis/0/rationale', '/market_evidence/evidence_gaps/0/how_to_close', '/personas/0/goals/0', '/product/non_goals/0',
  '/mvp/features/0/description', '/journeys/0/steps/0/action', '/architecture/summary', '/database/tables/0/purpose', '/implementation/tasks/0/title', '/testing/strategy',
  '/commercial/go_to_market/0/action', '/risks/unknowns/0/question', '/risks/evidence_limitations/0',
];

test('a URL in any model-written text is rejected, with the path of the field', () => {
  for (const p of TEXT_FIELDS) {
    for (const s of ['See https://example.com/page for details', 'at www.example.org', 'ftp://host/file']) {
      const d = validModelOutput();
      setAt(d, p, s);
      assertRejected(validateBlueprintModelOutput(d), 'contains_url', p, s);
    }
  }
});

test('executable or markup content in model-written text is rejected', () => {
  for (const p of TEXT_FIELDS) {
    for (const s of ['<script>alert(1)</script>', 'run ```rm -rf /```', 'javascript:void(0)']) {
      const d = validModelOutput();
      setAt(d, p, s);
      assertRejected(validateBlueprintModelOutput(d), 'contains_executable', p, s);
    }
  }
});

test('one string can carry several findings, reported once each at the same path', () => {
  const d = validModelOutput();
  setAt(d, '/testing/strategy', 'visit https://example.com then drop table reports');
  const codes = errorsOf(validateBlueprintModelOutput(d)).filter((e) => e.path === '/testing/strategy').map((e) => e.code).sort();
  assert.deepEqual(codes, ['contains_sql', 'contains_url']);
});

test('URLs are allowed in the backend-owned evidence index (they come from the database) but not in model text of the same blueprint', () => {
  const bp = validBlueprint();
  assert.ok(bp.evidence_index.some((e) => e.kind === 'discussion_excerpt' && e.url.startsWith('https://')));
  assertAccepted(validateProductBlueprint(bp));
  const bad = validBlueprint();
  setAt(bad, '/opportunity/title', 'Powered by https://example.com');
  assertRejected(validateProductBlueprint(bad), 'contains_url', '/opportunity/title');
});

test('the backend-owned excerpt text is not scanned as model text', () => {
  const bp = validBlueprint();
  setAt(bp, '/evidence_index/0/excerpt', 'A maintainer wrote: just run `DROP TABLE x` and see https://example.invalid/post');
  assertAccepted(validateProductBlueprint(bp));
});

test('names that must be identifiers cannot smuggle text: they fail on format, not on content', () => {
  const d = validModelOutput();
  setAt(d, '/database/tables/0/name', 'drop table x');
  const r = validateBlueprintModelOutput(d);
  assertRejected(r, 'invalid_format', '/database/tables/0/name');
  assertNoError(r, 'contains_sql', '/database/tables/0/name');
});
