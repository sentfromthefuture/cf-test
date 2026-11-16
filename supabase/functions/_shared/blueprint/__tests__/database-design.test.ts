// Database design: integrity (section 4, rules 9-11) and the rule that the design stays descriptive and never executable SQL.
// In the worked example: tables[0] = teams, tables[1] = team_members (composite primary key), tables[2] = reports (4 indexes, 3 foreign keys, 1 unique).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintModelOutputV1 } from '../contract.ts';
import { validateBlueprintModelOutput } from '../validate.ts';
import { assertAccepted, assertNoError, assertRejected, errorsOf, getAt, setAt, text, validModelOutput } from './helpers.ts';

const model = (): BlueprintModelOutputV1 => validModelOutput();
const validate = (d: unknown) => validateBlueprintModelOutput(d);
const T0 = '/database/tables/0';
const T1 = '/database/tables/1';
const T2 = '/database/tables/2';

// ---------------------------------------------------------------------------------------------------------------------------------
// Column types (closed list, section 3.6)
// ---------------------------------------------------------------------------------------------------------------------------------

test('column types come from the closed list; varchar and numeric carry sane parameters', () => {
  const type = (t: unknown) => { const d = model(); setAt(d, `${T0}/columns/0/data_type`, t); return validate(d); };
  const good = ['uuid', 'text', 'boolean', 'smallint', 'integer', 'bigint', 'real', 'double precision', 'date', 'time', 'timestamptz', 'jsonb', 'bytea', 'inet',
    'uuid[]', 'text[]', 'integer[]', 'bigint[]', 'varchar(1)', 'varchar(255)', 'varchar(10485760)', 'numeric(10,2)', 'numeric(1,0)', 'numeric(1000,1000)'];
  for (const t of good) assertAccepted(type(t), t);
  for (const t of ['serial', 'int', 'int4', 'VARCHAR(10)', 'UUID', 'text[][]', 'varchar', 'varchar()', 'varchar( 10 )', 'varchar(-1)', 'varchar(1.5)', 'numeric', 'numeric(10)',
    'numeric(10, 2)', 'timestamp', 'money', 'boolean[]', 'uuid; drop table x', '']) {
    assertRejected(type(t), t === '' ? 'invalid_enum' : 'invalid_enum', `${T0}/columns/0/data_type`, JSON.stringify(t));
  }
  assertRejected(type('varchar(0)'), 'number_out_of_range', `${T0}/columns/0/data_type`);
  assertRejected(type('varchar(10485761)'), 'number_out_of_range', `${T0}/columns/0/data_type`);
  assertRejected(type('numeric(0,0)'), 'number_out_of_range', `${T0}/columns/0/data_type`);
  assertRejected(type('numeric(1001,0)'), 'number_out_of_range', `${T0}/columns/0/data_type`);
  assertRejected(type('numeric(5,6)'), 'number_out_of_range', `${T0}/columns/0/data_type`);
  assertRejected(type(5), 'invalid_type', `${T0}/columns/0/data_type`);
});

test('table, column and workflow-state names are snake_case; table and column names are at most 40 characters', () => {
  const names: [string, string[], string[]][] = [
    [`${T0}/name`, ['teams', 'a', 'a_b_2', 'a'.repeat(40)], ['Teams', '2teams', 'a b', 'a-b', 'a'.repeat(41), '_teams', '']],
    [`${T0}/columns/0/name`, ['id', 'created_at', 'a'.repeat(40)], ['Id', 'created at', 'a'.repeat(41), 'ünï']],
    [`${T2}/primary_key/0`, ['id'], ['ID', 'a'.repeat(41)]],
  ];
  for (const [p, good, bad] of names) {
    for (const n of good) { const d = model(); setAt(d, p, n); assertNoError(validate(d), 'invalid_format', p, n); }
    for (const n of bad) { const d = model(); setAt(d, p, n); assertRejected(validate(d), 'invalid_format', p, JSON.stringify(n)); }
  }
});

test('constraint, index and policy names are lowercase identifiers of at most 63 characters', () => {
  for (const p of [`${T2}/foreign_keys/0/name`, `${T2}/unique_constraints/0/name`, `${T2}/check_constraints/0/name`, `${T2}/indexes/0/name`, `${T2}/rls/policies/0/name`]) {
    for (const bad of ['Has Space', 'UPPER', '1leading', 'x'.repeat(64), 'semi;colon', '']) {
      const d = model(); setAt(d, p, bad); assertRejected(validate(d), 'invalid_format', p, JSON.stringify(bad));
    }
    const d = model(); setAt(d, p, `${'x'.repeat(62)}1`); assertNoError(validate(d), 'invalid_format', p);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Names and columns that must exist and be unique
// ---------------------------------------------------------------------------------------------------------------------------------

test('table names and column names are unique', () => {
  const t = model(); setAt(t, `${T1}/name`, 'teams');
  assertRejected(validate(t), 'duplicate_identifier', `${T1}/name`);
  const c = model(); setAt(c, `${T0}/columns/1/name`, 'id');
  assertRejected(validate(c), 'duplicate_identifier', `${T0}/columns/1/name`);
});

test('primary-key, foreign-key, unique and index columns must exist in their table', () => {
  const pk = model(); setAt(pk, `${T0}/primary_key`, ['ghost']);
  assertRejected(validate(pk), 'db_column_reference', `${T0}/primary_key/0`);
  const fk = model(); setAt(fk, `${T2}/foreign_keys/0/columns`, ['ghost']);
  assertRejected(validate(fk), 'db_column_reference', `${T2}/foreign_keys/0/columns/0`);
  const uq = model(); setAt(uq, `${T2}/unique_constraints/0/columns`, ['team_id', 'ghost']);
  assertRejected(validate(uq), 'db_column_reference', `${T2}/unique_constraints/0/columns/1`);
  const ix = model(); setAt(ix, `${T2}/indexes/1/columns`, ['ghost']);
  assertRejected(validate(ix), 'db_column_reference', `${T2}/indexes/1/columns/0`);
});

test('a column list may not repeat a column', () => {
  const d = model(); setAt(d, `${T2}/indexes/0/columns`, ['team_id', 'team_id']);
  assertRejected(validate(d), 'duplicate_item', `${T2}/indexes/0/columns/1`);
});

test('index names are unique across the design; constraint and policy names are unique within a table', () => {
  const ix = model(); setAt(ix, `${T1}/indexes/0/name`, 'reports_assignee_idx');
  assertRejected(validate(ix), 'duplicate_identifier', `${T2}/indexes/1/name`);
  const ck = model(); setAt(ck, `${T1}/check_constraints/0/name`, 'team_members_team_fk');
  assertRejected(validate(ck), 'duplicate_identifier', `${T1}/check_constraints/0/name`);
  const pol = model(); setAt(pol, `${T2}/rls/policies/1/name`, 'reports_team_read');
  assertRejected(validate(pol), 'duplicate_identifier', `${T2}/rls/policies/1/name`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Foreign keys: target, arity, and index coverage on the referencing table (rule 11)
// ---------------------------------------------------------------------------------------------------------------------------------

test('a foreign key targets a table in the design or auth.users; columns of auth.users are not checked', () => {
  const unknown = model(); setAt(unknown, `${T2}/foreign_keys/0/references_table`, 'ghost');
  assertRejected(validate(unknown), 'db_table_reference', `${T2}/foreign_keys/0/references_table`);
  const missingColumn = model(); setAt(missingColumn, `${T2}/foreign_keys/0/references_columns`, ['ghost']);
  assertRejected(validate(missingColumn), 'db_column_reference', `${T2}/foreign_keys/0/references_columns/0`);
  const auth = model(); setAt(auth, `${T2}/foreign_keys/1/references_columns`, ['id']);
  assertAccepted(validate(auth));
  const authOther = model(); setAt(authOther, `${T2}/foreign_keys/1/references_columns`, ['email']);
  assertAccepted(validate(authOther));
  const selfRef = model(); // reports.duplicate_of -> reports.id is already in the example
  assert.equal(getAt(selfRef, `${T2}/foreign_keys/2/references_table`), 'reports');
  assertAccepted(validate(selfRef));
});

test('a foreign key references as many columns as it uses', () => {
  const d = model(); setAt(d, `${T2}/foreign_keys/0/references_columns`, ['id', 'name']);
  assertRejected(validate(d), 'db_fk_arity', `${T2}/foreign_keys/0/references_columns`);
});

const fkError = (d: unknown, table: string, k: number) => assertRejected(validate(d), 'db_fk_not_indexed', `${table}/foreign_keys/${k}/columns`);

test('a primary key covers a foreign key only when the foreign-key columns are its LEADING columns', () => {
  assertAccepted(validate(model())); // team_members.team_id is covered by primary key (team_id, user_id)
  const reordered = model(); setAt(reordered, `${T1}/primary_key`, ['user_id', 'team_id']); // team_id is no longer leading
  fkError(reordered, T1, 0);
  assertNoError(validate(reordered), 'db_fk_not_indexed', `${T1}/foreign_keys/1/columns`); // user_id now leads, and has its own index anyway
  const onlyPk = model(); setAt(onlyPk, `${T1}/indexes`, []); setAt(onlyPk, `${T1}/primary_key`, ['user_id', 'team_id']);
  fkError(onlyPk, T1, 0);
  assertNoError(validate(onlyPk), 'db_fk_not_indexed', `${T1}/foreign_keys/1/columns`); // covered by the primary key's leading column
});

test('a unique constraint covers a foreign key only when its leading columns do', () => {
  const noIndex = model(); setAt(noIndex, `${T2}/indexes/0`, undefined); // drop reports_team_status_idx; unique (team_id, channel, external_ref) still leads with team_id
  assertAccepted(validate(noIndex));
  const noUnique = model(); setAt(noUnique, `${T2}/indexes/0`, undefined); setAt(noUnique, `${T2}/unique_constraints`, []);
  fkError(noUnique, T2, 0);
  const notLeading = model(); setAt(notLeading, `${T2}/indexes/0`, undefined); setAt(notLeading, `${T2}/unique_constraints/0/columns`, ['channel', 'team_id', 'external_ref']);
  fkError(notLeading, T2, 0);
});

test('index column order matters: the foreign-key columns must lead', () => {
  const d = model(); setAt(d, `${T2}/unique_constraints`, []); setAt(d, `${T2}/indexes/0/columns`, ['status', 'team_id', 'created_at']);
  fkError(d, T2, 0);
  const lead = model(); setAt(lead, `${T2}/unique_constraints`, []); setAt(lead, `${T2}/indexes/0/columns`, ['team_id', 'status']);
  assertAccepted(validate(lead));
});

test('a partial index never covers a foreign key; neither does a gin index; a hash index covers a single-column key', () => {
  const partial = model(); setAt(partial, `${T2}/unique_constraints`, []); setAt(partial, `${T2}/indexes/0/partial_condition`, 'only reports that are still open');
  fkError(partial, T2, 0);
  const gin = model(); setAt(gin, `${T2}/indexes/1/method`, 'gin');
  fkError(gin, T2, 1);
  const hash = model(); setAt(hash, `${T2}/indexes/1/method`, 'hash');
  assertAccepted(validate(hash));
  const uniqueIndex = model(); setAt(uniqueIndex, `${T2}/unique_constraints`, []); setAt(uniqueIndex, `${T2}/indexes/0/unique`, true);
  assertAccepted(validate(uniqueIndex));
});

test('coverage is judged on the referencing table: an index on the referenced table does not help', () => {
  const d = model();
  setAt(d, `${T2}/indexes/0`, undefined); setAt(d, `${T2}/unique_constraints`, []); // reports.team_id uncovered
  setAt(d, `${T0}/indexes`, [{ name: 'teams_id_idx', columns: ['id'], method: 'btree', unique: true, purpose: 'Lookup by team' }]);
  fkError(d, T2, 0);
  const other = model(); // an index on another column of the referencing table does not help either
  setAt(other, `${T2}/indexes/1`, undefined); // drop reports_assignee_idx
  fkError(other, T2, 1);
});

test('the documented exception: an index purpose that names the foreign-key constraint', () => {
  const d = model();
  setAt(d, `${T2}/indexes/1`, undefined); // reports_assignee_idx gone; reports_assignee_fk is now uncovered
  fkError(d, T2, 1);
  setAt(d, `${T2}/indexes/1/purpose`, 'Duplicate lookups. Exception for reports_assignee_fk: the assignee column is never filtered on.');
  assertAccepted(validate(d));
  const wrongName = model(); setAt(wrongName, `${T2}/indexes/1`, undefined); setAt(wrongName, `${T2}/indexes/1/purpose`, 'Mentions some_other_fk only');
  fkError(wrongName, T2, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Row-level security and tenancy (rule 10)
// ---------------------------------------------------------------------------------------------------------------------------------

test('row-level security must be enabled on every table unless the tenancy model is public_read_only', () => {
  const off = model(); setAt(off, `${T0}/rls/enabled`, false);
  assertRejected(validate(off), 'db_rls_required', `${T0}/rls/enabled`);
  for (const t of ['single_tenant', 'user_owned_rows', 'organisation_scoped']) {
    const d = model(); setAt(d, '/database/tenancy_model', t); setAt(d, `${T0}/rls/enabled`, false);
    assertRejected(validate(d), 'db_rls_required', `${T0}/rls/enabled`, t);
  }
  const publicReadOnly = model(); setAt(publicReadOnly, '/database/tenancy_model', 'public_read_only');
  for (const i of [0, 1, 2]) setAt(publicReadOnly, `/database/tables/${i}/rls/enabled`, false);
  assertAccepted(validate(publicReadOnly));
});

test('user_owned_rows: every table needs owner_id or user_id, or a reason in rls.notes', () => {
  const d = model(); setAt(d, '/database/tenancy_model', 'user_owned_rows');
  // teams has neither column nor notes; team_members has user_id; reports has notes
  assertRejected(validate(d), 'db_owner_column_required', `${T0}/columns`);
  assertNoError(validate(d), 'db_owner_column_required', `${T1}/columns`);
  assertNoError(validate(d), 'db_owner_column_required', `${T2}/columns`);
  const withNotes = model(); setAt(withNotes, '/database/tenancy_model', 'user_owned_rows'); setAt(withNotes, `${T0}/rls/notes`, 'Teams are shared; ownership is through team_members.');
  assertAccepted(validate(withNotes));
  const withColumn = model(); setAt(withColumn, '/database/tenancy_model', 'user_owned_rows');
  setAt(withColumn, `${T0}/columns/2/name`, 'owner_id');
  assertAccepted(validate(withColumn));
  const other = model(); // organisation_scoped has no owner-column rule
  assertAccepted(validate(other));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The design stays descriptive: no executable SQL anywhere
// ---------------------------------------------------------------------------------------------------------------------------------

const DB_TEXT_FIELDS: string[] = [
  `${T0}/purpose`, `${T0}/columns/0/description`, `${T0}/columns/0/default`, `${T0}/check_constraints/0/rule`, `${T2}/indexes/0/purpose`, `${T2}/indexes/0/partial_condition`,
  `${T0}/rls/policies/0/rule`, `${T2}/rls/notes`, `${T0}/retention`, '/database/tenancy_rationale', '/database/conventions/0', '/database/migration_considerations/0', '/database/open_questions/0',
];

test('SQL statements are rejected in every free-text field of the database design', () => {
  const statements = [
    'CREATE TABLE reports (id uuid primary key)', 'drop table teams', 'ALTER TABLE reports ADD COLUMN x text', 'create unique index on reports (title)',
    'INSERT INTO teams VALUES (1)', 'delete from reports where id = 1', 'update reports set status = 1', 'SELECT * FROM reports', 'select id, title from reports where x',
    'grant select on reports to anon', 'create policy p on reports for select using (true)', "'; drop table teams; --", 'x UNION SELECT password FROM users',
  ];
  for (const p of DB_TEXT_FIELDS) {
    for (const s of statements) {
      const d = model();
      setAt(d, p, s);
      assertRejected(validate(d), 'contains_sql', p, s);
    }
  }
});

test('defaults, check rules, partial conditions and policy rules are described in words, never as expressions', () => {
  const expressionLike = ['now()', 'gen_random_uuid()', "'open'::text", 'auth.uid()', "status = 'open'", 'price > 0', 'length(name) > 0', 'a <> b', 'x >= 1', 'a || b', '1; 2', 'x -- comment', '`code`'];
  const fields = [`${T0}/columns/0/default`, `${T0}/check_constraints/0/rule`, `${T2}/indexes/0/partial_condition`, `${T0}/rls/policies/0/rule`];
  for (const p of fields) {
    for (const s of expressionLike) {
      const d = model();
      setAt(d, p, s);
      assertRejected(validate(d), 'contains_sql', p, s);
    }
  }
  const prose = ['generated identifier', 'the time the row was created', 'member', 'only reports that are still open', 'the signed-in user belongs to the team', 'role is either owner or member'];
  for (const p of fields) for (const s of prose) { const d = model(); setAt(d, p, s); assertNoError(validate(d), 'contains_sql', p, s); }
});

test('ordinary prose that merely uses SQL words is not rejected', () => {
  const prose = [
    'Create teams before team_members and reports', 'Delete the team reports on request', 'Select a report from the inbox', 'Update the status of a report',
    'Drop duplicate rows when importing', 'Backfill is not needed because the table is new', 'Insert rows only through the intake worker',
    'Reports from email land in the shared list', 'Grant admins access after review',
  ];
  for (const s of prose) {
    for (const p of ['/database/migration_considerations/0', `${T2}/purpose`, '/database/conventions/0']) {
      const d = model(); setAt(d, p, s);
      assertNoError(validate(d), 'contains_sql', p, s);
    }
  }
});

test('SQL content is rejected outside the database section too (every model-written text is scanned)', () => {
  for (const p of ['/opportunity/title', '/product/non_goals/0', '/implementation/tasks/0/description', '/testing/strategy', '/risks/risks/0/mitigation', '/personas/0/context']) {
    const d = model();
    setAt(d, p, 'First DROP TABLE reports then continue');
    assertRejected(validate(d), 'contains_sql', p);
  }
});

test('the SQL scan runs only after the shape is valid (tier order), and then reports every offending field', () => {
  const d = model();
  setAt(d, `${T0}/purpose`, 'drop table teams');
  setAt(d, '/database/conventions/0', 'create table x (a int)');
  const sqlErrors = errorsOf(validate(d)).filter((e) => e.code === 'contains_sql').map((e) => e.path);
  assert.deepEqual(sqlErrors.sort(), [`${T0}/purpose`, '/database/conventions/0'].sort());
  setAt(d, '/opportunity/title', text(500)); // now a shape error exists: tiers stop before the content scan
  assert.ok(!errorsOf(validate(d)).some((e) => e.code === 'contains_sql'));
});
