// Tier T5: identifier uniqueness, internal references, dependency cycles and database-design integrity
// (product-blueprint-v1.md section 4, "Cross-reference rules the validator enforces").
//
// Runs only on a structurally valid document (validate-model.ts already checked every shape, type, enum and bound), so values are read
// directly. Nothing here mutates the input, and every error carries a path and a fixed message - never text from the input.
import { MVP_MAX_MUST, MVP_MAX_SHOULD } from './constants.ts';
import type { BlueprintModelOutputV1, TableDesign } from './contract.ts';
import { at, Ctx } from './validate-core.ts';

type Known = ReadonlyMap<string, number>;

/** Registers the ids of one list, rejecting a repeated id at the later occurrence. Returns id -> index of the first occurrence. */
function declare<T>(c: Ctx, items: readonly T[], base: string, idKey: string, idOf: (item: T) => string): Known {
  const known = new Map<string, number>();
  items.forEach((item, i) => {
    const id = idOf(item);
    if (known.has(id)) c.err('duplicate_identifier', at(at(base, i), idKey), 'This identifier is already used by an earlier item in the same list.');
    else known.set(id, i);
  });
  return known;
}

/** Every id in `ids` must be declared in `known`. */
function resolve(c: Ctx, known: Known, ids: readonly string[], path: string, what: string): void {
  ids.forEach((id, i) => {
    if (!known.has(id)) c.err('unresolved_reference', at(path, i), `This entry refers to ${what} that is not defined in the blueprint.`);
  });
}

/** A single id (not a list): the error points at the field itself. */
function resolveOne(c: Ctx, known: Known, id: string, path: string, what: string): void {
  if (!known.has(id)) c.err('unresolved_reference', path, `This field refers to ${what} that is not defined in the blueprint.`);
}

/** Strongly connected components of size > 1, or a node that depends on itself: each is one cycle, reported once at its first member. */
function reportCycles(c: Ctx, ids: readonly string[], deps: ReadonlyMap<string, readonly string[]>, base: string, depKey: string): void {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const visit = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next)) continue; // unresolved: reported elsewhere
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id) as number, index.get(next) as number));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      const selfLoop = component.length === 1 && (deps.get(id) ?? []).includes(id);
      if (component.length > 1 || selfLoop) {
        const first = Math.min(...component.map((m) => ids.indexOf(m)));
        c.err('dependency_cycle', at(at(base, first), depKey), `The dependencies form a cycle involving ${component.length} item(s).`);
      }
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
}

export function checkIntegrity(c: Ctx, m: BlueprintModelOutputV1): void {
  const features = declare(c, m.mvp.features, '/mvp/features', 'feature_id', (f) => f.feature_id);
  const personas = declare(c, m.personas, '/personas', 'persona_id', (p) => p.persona_id);
  declare(c, m.journeys, '/journeys', 'journey_id', (j) => j.journey_id);
  declare(c, m.workflows, '/workflows', 'workflow_id', (w) => w.workflow_id);
  const components = declare(c, m.architecture.components, '/architecture/components', 'component_id', (k) => k.component_id);
  declare(c, m.architecture.decisions, '/architecture/decisions', 'decision_id', (d) => d.decision_id);
  const tasks = declare(c, m.implementation.tasks, '/implementation/tasks', 'task_id', (t) => t.task_id);
  declare(c, m.implementation.phases, '/implementation/phases', 'phase_id', (p) => p.phase_id);
  const criteria = declare(c, m.testing.acceptance_criteria, '/testing/acceptance_criteria', 'criterion_id', (a) => a.criterion_id);
  declare(c, m.testing.validation_experiments, '/testing/validation_experiments', 'experiment_id', (x) => x.experiment_id);
  declare(c, m.risks.risks, '/risks/risks', 'risk_id', (r) => r.risk_id);
  const assumptions = declare(c, m.risks.assumptions, '/risks/assumptions', 'assumption_id', (a) => a.assumption_id);
  const unknowns = declare(c, m.risks.unknowns, '/risks/unknowns', 'unknown_id', (u) => u.unknown_id);
  declare(c, m.market_evidence.evidence_gaps, '/market_evidence/evidence_gaps', 'gap_id', (g) => g.gap_id);
  declare(c, m.market_evidence.demand_signals, '/market_evidence/demand_signals', 'signal_id', (s) => s.signal_id);
  declare(c, m.commercial.pricing_hypotheses, '/commercial/pricing_hypotheses', 'hypothesis_id', (h) => h.hypothesis_id);
  declare(c, m.commercial.go_to_market, '/commercial/go_to_market', 'step_id', (s) => s.step_id);

  // --- references to personas, features, components -----------------------------------------------------------------------------
  m.mvp.features.forEach((f, i) => {
    resolve(c, personas, f.persona_ids, `/mvp/features/${i}/persona_ids`, 'a persona');
    resolve(c, features, f.depends_on, `/mvp/features/${i}/depends_on`, 'a feature');
  });
  m.journeys.forEach((j, i) => {
    resolveOne(c, personas, j.persona_id, `/journeys/${i}/persona_id`, 'a persona');
    j.steps.forEach((s, k) => resolve(c, features, s.feature_ids, `/journeys/${i}/steps/${k}/feature_ids`, 'a feature'));
  });
  m.workflows.forEach((w, i) => resolve(c, features, w.feature_ids, `/workflows/${i}/feature_ids`, 'a feature'));
  m.product.capabilities.forEach((cap, i) => resolve(c, features, cap.feature_ids, `/product/capabilities/${i}/feature_ids`, 'a feature'));
  m.architecture.components.forEach((k, i) => {
    resolve(c, features, k.feature_ids, `/architecture/components/${i}/feature_ids`, 'a feature');
    resolve(c, components, k.talks_to, `/architecture/components/${i}/talks_to`, 'a component');
  });
  m.database.tables.forEach((t, i) => resolve(c, features, t.feature_ids, `/database/tables/${i}/feature_ids`, 'a feature'));
  m.commercial.go_to_market.forEach((s, i) => resolve(c, personas, s.target_persona_ids, `/commercial/go_to_market/${i}/target_persona_ids`, 'a persona'));
  m.testing.acceptance_criteria.forEach((a, i) => resolveOne(c, features, a.feature_id, `/testing/acceptance_criteria/${i}/feature_id`, 'a feature'));
  m.testing.validation_experiments.forEach((x, i) => {
    x.tests.forEach((id, k) => {
      const known = id.startsWith('A') ? assumptions : unknowns;
      if (!known.has(id)) c.err('unresolved_reference', `/testing/validation_experiments/${i}/tests/${k}`, 'This entry refers to an assumption or unknown that is not defined in the blueprint.');
    });
  });

  // --- tasks, phases, critical path ----------------------------------------------------------------------------------------------
  m.implementation.tasks.forEach((t, i) => {
    resolve(c, features, t.feature_ids, `/implementation/tasks/${i}/feature_ids`, 'a feature');
    resolve(c, tasks, t.depends_on, `/implementation/tasks/${i}/depends_on`, 'a task');
    resolve(c, criteria, t.criterion_ids, `/implementation/tasks/${i}/criterion_ids`, 'an acceptance criterion');
  });
  const phaseOf = new Map<string, number>();
  m.implementation.phases.forEach((ph, i) => {
    resolve(c, tasks, ph.task_ids, `/implementation/phases/${i}/task_ids`, 'a task');
    ph.task_ids.forEach((id, k) => {
      if (!tasks.has(id)) return;
      if (phaseOf.has(id)) c.err('task_phase_assignment', `/implementation/phases/${i}/task_ids/${k}`, 'This task is already assigned to a phase; a task belongs to exactly one phase.');
      else phaseOf.set(id, i);
    });
  });
  m.implementation.tasks.forEach((t, i) => {
    if (!phaseOf.has(t.task_id)) c.err('task_phase_assignment', `/implementation/tasks/${i}/task_id`, 'This task is not assigned to any phase; a task belongs to exactly one phase.');
  });
  const taskDeps = new Map(m.implementation.tasks.map((t) => [t.task_id, t.depends_on] as const));
  const cp = m.implementation.critical_path;
  cp.forEach((id, i) => {
    const p = `/implementation/critical_path/${i}`;
    if (!tasks.has(id)) { c.err('unresolved_reference', p, 'This entry refers to a task that is not defined in the blueprint.'); return; }
    if (i > 0 && tasks.has(cp[i - 1]) && !(taskDeps.get(id) ?? []).includes(cp[i - 1])) {
      c.err('invalid_critical_path', p, 'Each task on the critical path must depend on the task before it.');
    }
  });

  // --- acyclic dependency graphs --------------------------------------------------------------------------------------------------
  reportCycles(c, m.mvp.features.map((f) => f.feature_id), new Map(m.mvp.features.map((f) => [f.feature_id, f.depends_on] as const)), '/mvp/features', 'depends_on');
  reportCycles(c, m.implementation.tasks.map((t) => t.task_id), taskDeps, '/implementation/tasks', 'depends_on');

  // --- MVP priorities, feature coverage ----------------------------------------------------------------------------------------------
  const mustCount = m.mvp.features.filter((f) => f.priority === 'must').length;
  const shouldCount = m.mvp.features.length - mustCount;
  if (mustCount > MVP_MAX_MUST) c.err('mvp_priority_limit', '/mvp/features', `At most ${MVP_MAX_MUST} MVP features may have priority "must".`);
  if (shouldCount > MVP_MAX_SHOULD) c.err('mvp_priority_limit', '/mvp/features', `At most ${MVP_MAX_SHOULD} MVP features may have priority "should".`);

  const featuresWithCriteria = new Set(m.testing.acceptance_criteria.map((a) => a.feature_id));
  const featuresWithTasks = new Set(m.implementation.tasks.flatMap((t) => t.feature_ids));
  const featuresWithCapabilities = new Set(m.product.capabilities.flatMap((cap) => cap.feature_ids));
  m.mvp.features.forEach((f, i) => {
    const p = `/mvp/features/${i}/feature_id`;
    if (!featuresWithCriteria.has(f.feature_id)) c.err('feature_without_criterion', p, 'Every MVP feature needs at least one acceptance criterion.');
    if (f.priority === 'must') {
      if (!featuresWithTasks.has(f.feature_id)) c.err('must_feature_uncovered', p, 'A "must" feature must be covered by at least one implementation task.');
      if (!featuresWithCapabilities.has(f.feature_id)) c.err('must_feature_uncovered', p, 'A "must" feature must be covered by at least one product capability.');
    }
  });

  // --- journeys and workflows ------------------------------------------------------------------------------------------------------
  m.journeys.forEach((j, i) => {
    const n = j.steps.length;
    const seen = new Set<number>();
    j.steps.forEach((s, k) => {
      const p = `/journeys/${i}/steps/${k}/order`;
      if (seen.has(s.order)) c.err('invalid_journey_order', p, 'Step numbers must be unique within a journey.');
      else if (s.order > n) c.err('invalid_journey_order', p, 'Step numbers must be contiguous, starting at 1.');
      seen.add(s.order);
    });
  });
  m.workflows.forEach((w, i) => {
    const states = declare(c, w.states, `/workflows/${i}/states`, 'name', (s) => s.name);
    w.transitions.forEach((t, k) => {
      if (!states.has(t.from)) c.err('invalid_workflow_transition', `/workflows/${i}/transitions/${k}/from`, 'The transition starts from a state that is not defined in this workflow.');
      if (!states.has(t.to)) c.err('invalid_workflow_transition', `/workflows/${i}/transitions/${k}/to`, 'The transition ends in a state that is not defined in this workflow.');
    });
  });

  // --- architecture decisions name one of their options -------------------------------------------------------------------------
  m.architecture.decisions.forEach((d, i) => {
    if (!d.options.some((o) => d.decision.includes(o.name))) c.err('decision_option_mismatch', `/architecture/decisions/${i}/decision`, 'The decision must name one of the options listed for it.');
  });

  checkDatabase(c, m);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Database design integrity (section 4 rules 9-11). Descriptive design only: nothing here produces or runs SQL.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * A foreign key is covered when some btree index (or hash index for a single column), the primary key, or a unique constraint on the
 * REFERENCING table has the foreign-key columns as its leading columns (any order). A partial index never counts. Alternatively the
 * documented exception applies: an index `purpose` on that table that names the foreign-key constraint.
 */
function foreignKeyCovered(t: TableDesign, fk: TableDesign['foreign_keys'][number]): boolean {
  const n = fk.columns.length;
  const need = new Set(fk.columns);
  const candidates: string[][] = [t.primary_key, ...t.unique_constraints.map((u) => u.columns)];
  for (const ix of t.indexes) {
    if (ix.partial_condition !== undefined) continue;
    if (ix.method === 'btree' || (ix.method === 'hash' && n === 1)) candidates.push(ix.columns);
  }
  if (candidates.some((cols) => cols.length >= n && cols.slice(0, n).every((col) => need.has(col)))) return true;
  const name = fk.name.toLowerCase();
  return t.indexes.some((ix) => ix.purpose.toLowerCase().includes(name));
}

function checkDatabase(c: Ctx, m: BlueprintModelOutputV1): void {
  const db = m.database;
  const tables = declare(c, db.tables, '/database/tables', 'name', (t) => t.name);
  const indexNames = new Map<string, true>();

  db.tables.forEach((t, i) => {
    const tp = `/database/tables/${i}`;
    const columns = declare(c, t.columns, `${tp}/columns`, 'name', (col) => col.name);
    const needColumns = (cols: readonly string[], path: string): void => {
      cols.forEach((col, k) => { if (!columns.has(col)) c.err('db_column_reference', at(path, k), 'This entry names a column that does not exist in this table.'); });
    };

    needColumns(t.primary_key, `${tp}/primary_key`);

    t.foreign_keys.forEach((fk, k) => {
      const fp = `${tp}/foreign_keys/${k}`;
      needColumns(fk.columns, `${fp}/columns`);
      if (fk.references_columns.length !== fk.columns.length) {
        c.err('db_fk_arity', `${fp}/references_columns`, 'A foreign key must reference the same number of columns as it uses.');
      }
      if (fk.references_table === 'auth.users') {
        // The platform's own table: its columns are not part of this design and cannot be checked here.
      } else if (!tables.has(fk.references_table)) {
        c.err('db_table_reference', `${fp}/references_table`, 'The referenced table is neither in this design nor auth.users.');
      } else {
        const target = db.tables[tables.get(fk.references_table) as number];
        const targetColumns = new Set(target.columns.map((col) => col.name));
        fk.references_columns.forEach((col, r) => {
          if (!targetColumns.has(col)) c.err('db_column_reference', `${fp}/references_columns/${r}`, 'This entry names a column that does not exist in the referenced table.');
        });
      }
      if (!foreignKeyCovered(t, fk)) {
        c.err('db_fk_not_indexed', `${fp}/columns`, 'The foreign-key columns must be covered by an index, the primary key or a unique constraint on this table (leading columns), or an index purpose must name this constraint as an exception.');
      }
    });

    t.unique_constraints.forEach((u, k) => needColumns(u.columns, `${tp}/unique_constraints/${k}/columns`));
    t.indexes.forEach((ix, k) => {
      needColumns(ix.columns, `${tp}/indexes/${k}/columns`);
      if (indexNames.has(ix.name)) c.err('duplicate_identifier', `${tp}/indexes/${k}/name`, 'Index names must be unique across the design.');
      indexNames.set(ix.name, true);
    });

    // Constraint names are unique per table in PostgreSQL; policy names too.
    const constraintNames = new Map<string, true>();
    const claimName = (name: string, path: string): void => {
      if (constraintNames.has(name)) c.err('duplicate_identifier', path, 'Constraint names must be unique within a table.');
      constraintNames.set(name, true);
    };
    t.foreign_keys.forEach((fk, k) => claimName(fk.name, `${tp}/foreign_keys/${k}/name`));
    t.unique_constraints.forEach((u, k) => claimName(u.name, `${tp}/unique_constraints/${k}/name`));
    t.check_constraints.forEach((ck, k) => claimName(ck.name, `${tp}/check_constraints/${k}/name`));
    const policyNames = new Map<string, true>();
    t.rls.policies.forEach((pol, k) => {
      if (policyNames.has(pol.name)) c.err('duplicate_identifier', `${tp}/rls/policies/${k}/name`, 'Policy names must be unique within a table.');
      policyNames.set(pol.name, true);
    });

    // Rule 10: row-level security is enabled everywhere except in a public read-only design.
    if (db.tenancy_model !== 'public_read_only' && !t.rls.enabled) {
      c.err('db_rls_required', `${tp}/rls/enabled`, 'Row-level security must be enabled for every table unless the tenancy model is public_read_only.');
    }
    // Rule 10: in user_owned_rows every table carries owner_id or user_id, or explains why not in rls.notes.
    if (db.tenancy_model === 'user_owned_rows' && !columns.has('owner_id') && !columns.has('user_id') && t.rls.notes === undefined) {
      c.err('db_owner_column_required', `${tp}/columns`, 'In a user_owned_rows design every table needs an owner_id or user_id column, or a reason in rls.notes.');
    }
  });
}
