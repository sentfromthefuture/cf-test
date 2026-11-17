// Phase A3: grounding guards (evidence contract sections 3.3, 5.3 and 6). Each guard is tested on its own. Synthetic data only.
//
// These tests also pin down the KNOWN LIMITS of the lexical checks (see the header of evidence-grounding.ts): where a guard is deliberately
// weak, a test says so, so nobody reads a passing guard as proof that an excerpt supports a claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroundingContext, checkGeneralisation, checkNameGrounding, checkNumericGrounding, checkRelevanceFloor, checkSupportingGrade,
  checkWtpEvidence, containsGeneralisation, contentStems, extractNumerals, isSupportingGrade, normaliseForMatch, renderMetricValue, statesPriceOrShare,
} from '../evidence.ts';
import type { ClusterInput, GroundingContext } from '../evidence.ts';
import { groundedCompetitors } from '../../collector/heuristics.ts';
import { input, member, prepared } from './evidence-fixtures.ts';

interface Ex { text: string; title?: string | null; wtp?: boolean }

/** A grounding context over the given excerpts (E01.. in order) plus the full metric catalogue of the default cluster. */
function ctxWith(excerpts: Ex[], clusterOver: Partial<ClusterInput> = {}): GroundingContext {
  const members = excerpts.map((e, i) => member({ n: i + 1, text: e.text, title: e.title === undefined ? null : e.title, wtp: e.wtp ?? false }));
  return buildGroundingContext(prepared(input(members, clusterOver)).pack);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Supporting grade (section 3.3)
// ---------------------------------------------------------------------------------------------------------------------------------

test('supporting grade: an excerpt always is; a metric of class measured or derived is; ai_estimate and insufficient_data never are', () => {
  const ctx = ctxWith([{ text: 'something an author wrote' }], { growth_rate: null });
  assert.equal(isSupportingGrade(ctx, 'E01'), true);
  for (const id of ['M01', 'M02', 'M04', 'M05', 'M06', 'M07', 'M08', 'M10', 'M11', 'M12', 'M14', 'M15']) assert.equal(isSupportingGrade(ctx, id), true, id);
  for (const id of ['M03' /* null growth */, 'M09' /* AI estimate */, 'M13', 'M16' /* AI-estimate components */]) assert.equal(isSupportingGrade(ctx, id), false, id);
});

test('supporting grade: an id the pack never issued supports nothing', () => {
  const ctx = ctxWith([{ text: 'x' }]);
  for (const id of ['E02', 'E99', 'M17', 'M00', 'nope', '']) assert.equal(isSupportingGrade(ctx, id), false, id);
});

test('supporting grade: a verified claim needs at least one supporting-grade reference among its refs', () => {
  const ctx = ctxWith([{ text: 'an author wrote this' }]);
  assert.deepEqual(checkSupportingGrade(ctx, ['E01']), { passed: true, reason: 'ok' });
  assert.deepEqual(checkSupportingGrade(ctx, ['M01']), { passed: true, reason: 'ok' });
  assert.deepEqual(checkSupportingGrade(ctx, ['M09', 'E01']), { passed: true, reason: 'ok' });  // one supporting item is enough
  for (const refs of [[], ['M09'], ['M13', 'M16'], ['E99'], ['M09', 'E99']]) {
    assert.deepEqual(checkSupportingGrade(ctx, refs), { passed: false, reason: 'no_supporting_grade_item' }, JSON.stringify(refs));
  }
});

test('supporting grade: an AI estimate cannot be cited into support, however many are cited', () => {
  const ctx = ctxWith([{ text: 'x' }]);
  assert.equal(checkSupportingGrade(ctx, ['M09', 'M13', 'M16', 'M09']).passed, false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Name grounding (section 5.3.1)
// ---------------------------------------------------------------------------------------------------------------------------------

test('name grounding: a name that appears in a cited excerpt passes, ignoring case, quote style and white space', () => {
  const ctx = ctxWith([{ text: 'We tried Notion and Linear but both felt heavy.' }, { text: 'It’s Jira’s workflow that hurts, and   Open   Project is no better.' }]);
  assert.equal(checkNameGrounding(ctx, 'Notion', ['E01']).passed, true);
  assert.equal(checkNameGrounding(ctx, 'LINEAR', ['E01']).passed, true);
  assert.equal(checkNameGrounding(ctx, "Jira's", ['E02']).passed, true);        // straight quote in the name, curly in the text
  assert.equal(checkNameGrounding(ctx, 'open project', ['E02']).passed, true);  // white space normalised
  assert.equal(checkNameGrounding(ctx, '  Notion  ', ['E01']).passed, true);    // surrounding white space of the name ignored
});

test('name grounding: a name that is not in the cited excerpts fails, even if it is in an excerpt that is not cited', () => {
  const ctx = ctxWith([{ text: 'We tried Notion.' }, { text: 'Nothing relevant here.' }]);
  assert.deepEqual(checkNameGrounding(ctx, 'Airtable', ['E01', 'E02']), { passed: false, reason: 'name_not_in_cited_excerpts' });
  assert.deepEqual(checkNameGrounding(ctx, 'Notion', ['E02']), { passed: false, reason: 'name_not_in_cited_excerpts' });
  assert.deepEqual(checkNameGrounding(ctx, 'Notion', []), { passed: false, reason: 'name_not_in_cited_excerpts' });
  assert.deepEqual(checkNameGrounding(ctx, 'Notion', ['E99']), { passed: false, reason: 'name_not_in_cited_excerpts' });
});

test('name grounding: only the TEXT of an excerpt counts (not its title) and only excerpts count (not the competitor metric M10)', () => {
  const ctx = ctxWith([{ text: 'nothing here', title: 'Notion review' }], { competitors: { notion: 3 } });
  assert.equal(checkNameGrounding(ctx, 'Notion', ['E01']).passed, false);
  assert.equal(checkNameGrounding(ctx, 'notion', ['E01', 'M10']).passed, false);
});

test('name grounding: the name must be 2 to 60 characters', () => {
  const sixty = 'A'.repeat(60);
  const ctx = ctxWith([{ text: `x ${sixty} y and Go and a` }]);
  assert.deepEqual(checkNameGrounding(ctx, 'a', ['E01']), { passed: false, reason: 'name_length_out_of_range' });
  assert.deepEqual(checkNameGrounding(ctx, ' ', ['E01']), { passed: false, reason: 'name_length_out_of_range' });
  assert.deepEqual(checkNameGrounding(ctx, 'A'.repeat(61), ['E01']), { passed: false, reason: 'name_length_out_of_range' });
  assert.equal(checkNameGrounding(ctx, 'Go', ['E01']).passed, true);        // 2 characters: allowed
  assert.equal(checkNameGrounding(ctx, sixty, ['E01']).passed, true);       // 60 characters: allowed
  assert.deepEqual(checkNameGrounding(ctx, 42 as unknown as string, ['E01']), { passed: false, reason: 'name_length_out_of_range' });
});

test('name grounding LIMIT: it is a substring match, so a short name can match inside another word', () => {
  const ctx = ctxWith([{ text: 'This is a good tool.' }]);
  assert.equal(checkNameGrounding(ctx, 'Go', ['E01']).passed, true);
});

test('name grounding agrees with the existing matcher (groundedCompetitors) on a table of cases', () => {
  const cases: [string, string][] = [
    ['Notion', 'we tried Notion for this'], ['notion', 'We tried NOTION'], ['Jira', 'it’s all in jira tickets'], ["Jira's", 'It’s Jira’s fault'],
    ['Open Project', 'open   project works'], ['Slack', 'we use email'], ['x', 'x marks'], ['Go', 'good'], ['Trello', 'Trello, Asana'], ['Asana ', 'Trello, asana'],
    ['“Quoted”', 'He said "quoted" twice'],
  ];
  for (const [name, text] of cases) {
    const existing = groundedCompetitors([name], text).length === 1;
    const ctx = ctxWith([{ text }]);
    const ours = checkNameGrounding(ctx, name, ['E01']).passed;
    // The prepared excerpt is whitespace-normalised, which the matcher does as well, so the two always agree.
    assert.equal(ours, existing, `${JSON.stringify(name)} in ${JSON.stringify(text)}`);
  }
});

test('normaliseForMatch: lower case, straight quotes, single spaces, trimmed', () => {
  assert.equal(normaliseForMatch('  It’s “Fine”  \n here '), 'it\'s "fine" here');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Numeric grounding (section 5.3.2)
// ---------------------------------------------------------------------------------------------------------------------------------

test('extractNumerals: whole numeric tokens, with thousands separators removed and full-width digits folded', () => {
  const cases: [string, string[]][] = [
    ['60%', ['60']], ['1,000 and 2.5', ['1000', '2.5']], ['E01', ['01']], ['v2 of Q3', ['2', '3']], ['２０２６', ['2026']], ['5.', ['5']], ['3,5', ['35']],
    ['no digits here', []], ['', []], ['1.2.3', ['1.2.3']], ['$20/month', ['20']], ['3-5', ['3', '5']],
  ];
  for (const [text, expected] of cases) assert.deepEqual(extractNumerals(text), expected, text);
});

test('numeric grounding: the contract example 11.2 - "60%" appears in no cited item, so it fails (and E99 resolves to nothing)', () => {
  const ctx = ctxWith([{ text: 'a', wtp: true }, { text: 'b' }, { text: 'c' }, { text: 'Our support inbox, issue tracker and chat are three separate worlds. I would pay for something simple.', wtp: true }]);
  assert.deepEqual(checkNumericGrounding(ctx, 'About 60% of small teams would pay for this.', ['E04', 'E99']), { passed: false, reason: 'numeral_not_in_cited_evidence' });
});

test('numeric grounding: a numeral that appears in a cited excerpt passes; the same numeral in an uncited excerpt does not', () => {
  const ctx = ctxWith([{ text: 'We lose about 60 reports a week.' }, { text: 'Seven teams, 12 people.' }]);
  assert.equal(checkNumericGrounding(ctx, 'Around 60 reports weekly are lost.', ['E01']).passed, true);
  assert.equal(checkNumericGrounding(ctx, 'Around 60 reports weekly are lost.', ['E02']).passed, false);
  assert.equal(checkNumericGrounding(ctx, 'Around 60 reports weekly are lost.', ['E01', 'E02']).passed, true);
  assert.equal(checkNumericGrounding(ctx, 'Teams of 12 people lose 60 reports.', ['E01', 'E02']).passed, true); // each numeral in some cited excerpt
  assert.equal(checkNumericGrounding(ctx, 'Teams of 12 people lose 60 reports.', ['E01']).passed, false);        // 12 only in E02
});

test('numeric grounding: numerals are whole tokens - 10 is not grounded by 100, 3.5 not by 35, and 1,000 equals 1000', () => {
  const ctx = ctxWith([{ text: 'We have 100 users and 35 tickets and 1000 emails.' }]);
  assert.equal(checkNumericGrounding(ctx, 'Ten of the 10 users', ['E01']).passed, false);
  assert.equal(checkNumericGrounding(ctx, 'rated 3.5', ['E01']).passed, false);
  assert.equal(checkNumericGrounding(ctx, 'about 1,000 emails', ['E01']).passed, true);
  assert.equal(checkNumericGrounding(ctx, '100 users', ['E01']).passed, true);
});

test('numeric grounding: a claim with no numeral passes whatever it cites (or does not cite)', () => {
  const ctx = ctxWith([{ text: 'x' }]);
  assert.deepEqual(checkNumericGrounding(ctx, 'Teams lose reports.', []), { passed: true, reason: 'ok' });
});

test('numeric grounding: the rendered value of a measured or derived metric grounds a number', () => {
  const ctx = ctxWith([{ text: 'x' }]);   // default cluster: M01 = 12, M02 = 3
  assert.equal(checkNumericGrounding(ctx, 'Twelve... no: 12 independent discussions.', ['M01']).passed, true);
  assert.equal(checkNumericGrounding(ctx, '3 sources', ['M02']).passed, true);
  assert.equal(checkNumericGrounding(ctx, '13 independent discussions', ['M01']).passed, false);
});

test('numeric grounding: an AI-estimate or insufficient-data metric never grounds a number (it supports nothing)', () => {
  const ctx = ctxWith([{ text: 'no figures in this excerpt' }]);              // M09 renders 3.5 (AI estimate), M13 renders 65 (AI estimate)
  assert.equal(checkNumericGrounding(ctx, 'Severity is 3.5', ['M09']).passed, false);
  assert.equal(checkNumericGrounding(ctx, 'Severity is 3.5', ['M09', 'E01']).passed, false);
  assert.equal(checkNumericGrounding(ctx, 'Pain scores 65', ['M13']).passed, false);
  const nullGrowth = ctxWith([{ text: 'x' }], { growth_rate: null });
  assert.equal(checkNumericGrounding(nullGrowth, 'Growth is 10', ['M03']).passed, false);
});

test('numeric grounding: an unissued id grounds nothing', () => {
  const ctx = ctxWith([{ text: 'We lose 60 reports.' }]);
  assert.equal(checkNumericGrounding(ctx, '60 reports', ['E02', 'M99']).passed, false);
});

test('numeric grounding: full-width digits cannot hide a figure', () => {
  const ctx = ctxWith([{ text: 'We lose 60 reports.' }]);
  assert.equal(checkNumericGrounding(ctx, '６０ reports', ['E01']).passed, true);   // folds to 60, which is in the excerpt
  assert.equal(checkNumericGrounding(ctx, '７７ reports', ['E01']).passed, false);  // folds to 77, which is not
});

test('numeric grounding LIMITS: number words are not checked, and a bucket label can ground a figure that is not the exact count', () => {
  const ctx = ctxWith([{ text: 'no figures' }]);   // default cluster: M07 recent_discussions = 4 -> bucket "3-5"
  assert.equal(checkNumericGrounding(ctx, 'Three hundred teams said so.', ['E01']).passed, true);          // words are invisible to the guard
  assert.equal(checkNumericGrounding(ctx, '5 recent discussions', ['M07']).passed, true);                  // "5" occurs in the label "3-5"
});

test('numeric grounding: an id written inside the claim text counts as a numeral (strict by design)', () => {
  const ctx = ctxWith([{ text: 'We lose reports.' }]);
  assert.equal(checkNumericGrounding(ctx, 'Teams lose reports (E01).', ['E01']).passed, false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Relevance floor (section 5.3.3)
// ---------------------------------------------------------------------------------------------------------------------------------

test('contentStems: words of five or more letters, not stop words, cut to their first five letters', () => {
  assert.deepEqual([...contentStems('Reports and REPORTING of duplicates, which would hurt')].sort(), ['dupli', 'repor']);
  assert.deepEqual([...contentStems('a bug in the app')], []);
  assert.deepEqual([...contentStems('about their which would should')], []);
  assert.deepEqual([...contentStems('résumés and Straße')].sort(), ['résum', 'straß']);
});

test('relevance floor: the contract example 11.1 passes - shared stems (repor, email, chat, dupli) occur in the cited text', () => {
  const ctx = ctxWith([
    { text: 'We get bug reports by email, in issues and in chat and I keep losing track.' },
    { text: 'Anyone have a lightweight way to merge support email with GitHub issues?' },
    { text: 'Half my mornings go to closing duplicates of the same report.' },
  ]);
  const claim = 'Teams report that bug reports arrive in issue trackers, email and chat and that duplicates and lost reports are common.';
  assert.deepEqual(checkRelevanceFloor(ctx, claim, ['E01', 'E02', 'E03']), { passed: true, reason: 'ok' });
});

test('relevance floor: a real id attached to an unrelated sentence fails', () => {
  const ctx = ctxWith([{ text: 'We get bug reports by email and chat.' }]);
  assert.deepEqual(checkRelevanceFloor(ctx, 'Customers want a dark interface theme.', ['E01']), { passed: false, reason: 'no_shared_content_word' });
});

test('relevance floor: matching is by the first five letters, so singular, plural and inflected forms match', () => {
  const ctx = ctxWith([{ text: 'Please integrate the report exports.' }]);
  assert.equal(checkRelevanceFloor(ctx, 'Teams want integration', ['E01']).passed, true);   // integ
  assert.equal(checkRelevanceFloor(ctx, 'Reporting is slow', ['E01']).passed, true);         // repor
  assert.equal(checkRelevanceFloor(ctx, 'EXPORTING is slow', ['E01']).passed, true);         // expor (case-insensitive)
});

test('relevance floor: a shared word in the TITLE counts, and only cited excerpts are searched', () => {
  const ctx = ctxWith([{ text: 'nothing alike', title: 'Spreadsheet chaos' }, { text: 'spreadsheet everywhere' }]);
  assert.equal(checkRelevanceFloor(ctx, 'Spreadsheets are used', ['E01']).passed, true);                                  // via the title
  assert.equal(checkRelevanceFloor(ctx, 'Spreadsheets are used', ['E01']).reason, 'ok');
  const other = ctxWith([{ text: 'completely different words' }, { text: 'spreadsheet everywhere' }]);
  assert.equal(checkRelevanceFloor(other, 'Spreadsheets are used', ['E01']).passed, false);                               // E02 has it but is not cited
  assert.equal(checkRelevanceFloor(other, 'Spreadsheets are used', ['E01', 'E02']).passed, true);
});

test('relevance floor: stop words and short words do not count as content', () => {
  const ctx = ctxWith([{ text: 'which would their about these those' }]);
  assert.deepEqual(checkRelevanceFloor(ctx, 'It is a bad one.', ['E01']), { passed: false, reason: 'no_content_words' });
  assert.deepEqual(checkRelevanceFloor(ctx, 'which would their about', ['E01']), { passed: false, reason: 'no_content_words' });
  const ctx2 = ctxWith([{ text: 'bugs mail' }]);
  assert.equal(checkRelevanceFloor(ctx2, 'bugs mail', ['E01']).passed, false);   // four-letter words are not content words
});

test('relevance floor: it applies only when the claim cites an excerpt', () => {
  const ctx = ctxWith([{ text: 'x' }]);
  assert.deepEqual(checkRelevanceFloor(ctx, 'Unrelated sentence entirely.', ['M01']), { passed: true, reason: 'not_applicable' });
  assert.deepEqual(checkRelevanceFloor(ctx, 'Unrelated sentence entirely.', []), { passed: true, reason: 'not_applicable' });
  assert.deepEqual(checkRelevanceFloor(ctx, 'Unrelated sentence entirely.', ['E99']), { passed: true, reason: 'not_applicable' });
});

test('relevance floor LIMIT: one shared stem is enough, so a sentence that shares a word but contradicts the excerpt still passes', () => {
  const ctx = ctxWith([{ text: 'Duplicate reports are rare for us.' }]);
  assert.equal(checkRelevanceFloor(ctx, 'Duplicate reports are the main cause of churn.', ['E01']).passed, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Generalisation guard
// ---------------------------------------------------------------------------------------------------------------------------------

test('generalisation: each trigger word needs two supporting-grade items; one is not enough', () => {
  const ctx = ctxWith([{ text: 'a' }, { text: 'b' }]);
  for (const word of ['many', 'most', 'several', 'often', 'commonly', 'repeatedly', 'everyone', 'always', 'never', 'all']) {
    const claim = `Teams ${word} lose reports.`;
    assert.deepEqual(checkGeneralisation(ctx, claim, ['E01']), { passed: false, reason: 'generalisation_needs_two_supporting_items' }, word);
    assert.deepEqual(checkGeneralisation(ctx, claim, ['E01', 'E02']), { passed: true, reason: 'ok' }, word);
  }
});

test('generalisation: the two items must be distinct and supporting-grade (an AI estimate or an unissued id does not count)', () => {
  const ctx = ctxWith([{ text: 'a' }, { text: 'b' }]);
  const claim = 'Many teams lose reports.';
  assert.equal(checkGeneralisation(ctx, claim, ['E01', 'E01']).passed, false);          // the same excerpt twice
  assert.equal(checkGeneralisation(ctx, claim, ['E01', 'M09']).passed, false);          // M09 is an AI estimate
  assert.equal(checkGeneralisation(ctx, claim, ['E01', 'E99']).passed, false);          // E99 was never issued
  assert.equal(checkGeneralisation(ctx, claim, ['E01', 'M01']).passed, true);           // excerpt + measured metric
  assert.equal(checkGeneralisation(ctx, claim, ['M01', 'M02']).passed, true);           // two measured metrics
});

test('generalisation: matching is case-insensitive, on whole words, and sees through full-width letters', () => {
  const ctx = ctxWith([{ text: 'a' }]);
  for (const claim of ['Many teams.', 'MANY teams.', 'teams (all) agree', 'It is always so.', 'Never again!', 'ｍａｎｙ teams']) {
    assert.equal(containsGeneralisation(claim), true, claim);
    assert.equal(checkGeneralisation(ctx, claim, ['E01']).passed, false, claim);
  }
  for (const claim of ['Overall teams lose reports.', 'Mostly fine.', 'An allowance exists.', 'Manyfold gains.', 'One maintainer says reports get lost.', 'Teams recall nothing.']) {
    assert.equal(containsGeneralisation(claim), false, claim);
    assert.equal(checkGeneralisation(ctx, claim, ['E01']).passed, true, claim);
  }
});

test('generalisation LIMIT: it is a fixed English word list, so a paraphrase of "many" is not detected', () => {
  assert.equal(containsGeneralisation('A large number of teams lose reports.'), false);
  assert.equal(containsGeneralisation('The majority of teams lose reports.'), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Willingness to pay (section 6)
// ---------------------------------------------------------------------------------------------------------------------------------

const WTP_TEXT = 'Some authors said they would pay for a tool that joins these channels.';
const wtpCtx = () => ctxWith([{ text: 'quote one', wtp: true }, { text: 'quote two', wtp: true }, { text: 'no quote here', wtp: false }, { text: 'quote four', wtp: true }]);
const evidenced = (refs: string[], over: Partial<Parameters<typeof checkWtpEvidence>[1]> = {}) =>
  checkWtpEvidence(wtpCtx(), { status: 'evidenced', basis: 'verified_evidence', evidence_refs: refs, text: WTP_TEXT, ...over });

test('WTP: "evidenced" needs two independent excerpts that both carry a willingness-to-pay quote', () => {
  assert.deepEqual(evidenced(['E01', 'E02']), { passed: true, reason: 'ok', flagged_excerpts: 2 });
  assert.deepEqual(evidenced(['E01', 'E02', 'E04']), { passed: true, reason: 'ok', flagged_excerpts: 3 });
});

test('WTP: one quote is deliberately not enough (the worked example has one flagged excerpt and must report not_evidenced)', () => {
  assert.deepEqual(evidenced(['E04']), { passed: false, reason: 'wtp_needs_two_flagged_excerpts', flagged_excerpts: 1 });
  assert.deepEqual(evidenced(['E01']), { passed: false, reason: 'wtp_needs_two_flagged_excerpts', flagged_excerpts: 1 });
});

test('WTP: an excerpt without the flag does not count, the same excerpt twice counts once, and a metric is not an excerpt', () => {
  assert.equal(evidenced(['E01', 'E03']).flagged_excerpts, 1);                       // E03 carries no quote
  assert.equal(evidenced(['E01', 'E01']).flagged_excerpts, 1);                       // duplicates
  assert.equal(evidenced(['E01', 'M04']).flagged_excerpts, 1);                       // M04 (wtp_signal_count) is a metric
  assert.equal(evidenced(['E01', 'E99']).flagged_excerpts, 1);                       // never issued
  for (const refs of [['E01', 'E03'], ['E01', 'E01'], ['E01', 'M04'], ['E01', 'E99'], []]) assert.equal(evidenced(refs).passed, false, JSON.stringify(refs));
});

test('WTP: "evidenced" is acceptable only for a verified_evidence summary', () => {
  for (const basis of ['hypothesis', 'unknown', 'ai_recommendation'] as const) {
    assert.deepEqual(evidenced(['E01', 'E02'], { basis }), { passed: false, reason: 'wtp_basis_not_verified', flagged_excerpts: 2 }, basis);
  }
});

test('WTP: the rule does not apply to other statuses (their canonical replacement belongs to the verifier)', () => {
  for (const status of ['not_evidenced', 'unknown'] as const) {
    assert.deepEqual(evidenced(['E01'], { status, basis: 'unknown' }), { passed: true, reason: 'not_applicable', flagged_excerpts: 1 }, status);
  }
});

test('WTP: the text may not state a price, a budget or a share - currency amounts and percentages are caught', () => {
  for (const text of [
    'Some authors would pay $20 per month.', 'They would pay 20$.', 'About €5 a month.', 'Around £10.', 'They said 20 USD.', 'ZMW 150 per seat.', '150 zmw a month.',
    'About 5 dollars.', 'Maybe 3 kwacha.', 'Roughly 60% would pay.', 'Sixty percent would pay.', '60 per cent said so.', '60 percentage points', '６０％ would pay',
  ]) {
    assert.deepEqual(evidenced(['E01', 'E02'], { text }), { passed: false, reason: 'wtp_text_states_figure', flagged_excerpts: 2 }, text);
    assert.equal(statesPriceOrShare(text), true, text);
  }
  for (const text of [WTP_TEXT, 'Some authors said they would pay.', 'Version 2.0 shipped in 2026 for 5 users.', 'They said it was worth paying for.']) {
    assert.equal(statesPriceOrShare(text), false, text);
    assert.equal(evidenced(['E01', 'E02'], { text }).passed, true, text);
  }
});

test('WTP: the price rule stands on its own - an excerpt can contain a price, the numbers guard then lets a claim repeat it, and the WTP rule still refuses', () => {
  const ctx = ctxWith([{ text: 'I would pay $20 per month for this.', wtp: true }, { text: 'Happy to pay $20 too.', wtp: true }]);
  const claim = 'Some authors said they would pay $20.';
  assert.equal(checkNumericGrounding(ctx, claim, ['E01', 'E02']).passed, true);     // 20 is in the excerpts
  assert.deepEqual(checkWtpEvidence(ctx, { status: 'evidenced', basis: 'verified_evidence', evidence_refs: ['E01', 'E02'], text: claim }),
    { passed: false, reason: 'wtp_text_states_figure', flagged_excerpts: 2 });
});

test('WTP LIMIT: a price or share written in words is not detected', () => {
  assert.equal(statesPriceOrShare('Half of the authors said they would pay a few hundred.'), false);
});

test('WTP: an unissued id cannot be counted as a flagged excerpt', () => {
  assert.equal(evidenced(['E99', 'E98']).flagged_excerpts, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Rendering and independence
// ---------------------------------------------------------------------------------------------------------------------------------

test('renderMetricValue: how each kind of metric value is written for the numbers guard', () => {
  assert.equal(renderMetricValue(null), '');
  assert.equal(renderMetricValue(12), '12');
  assert.equal(renderMetricValue(3.5), '3.5');
  assert.equal(renderMetricValue('3-5'), '3-5');
  assert.equal(renderMetricValue(true), 'true');
  assert.equal(renderMetricValue(['github', 'hackernews']), 'github hackernews');
  assert.equal(renderMetricValue({ zeta: 1, alpha: 2 }), 'alpha 2 zeta 1');
});

test('the guards are independent: each can fail while the others pass', () => {
  const ctx = ctxWith([{ text: 'Duplicate reports waste my mornings.' }, { text: 'Reports pile up in email.' }]);
  const refs = ['E01', 'E02'];
  // numerals fail only
  assert.deepEqual([checkNumericGrounding(ctx, 'Duplicate reports waste 99 mornings.', refs).passed, checkRelevanceFloor(ctx, 'Duplicate reports waste 99 mornings.', refs).passed,
    checkGeneralisation(ctx, 'Duplicate reports waste 99 mornings.', refs).passed], [false, true, true]);
  // relevance fails only
  assert.deepEqual([checkNumericGrounding(ctx, 'Customers want dark themes.', refs).passed, checkRelevanceFloor(ctx, 'Customers want dark themes.', refs).passed,
    checkGeneralisation(ctx, 'Customers want dark themes.', refs).passed], [true, false, true]);
  // generalisation fails only
  assert.deepEqual([checkNumericGrounding(ctx, 'Many duplicate reports waste mornings.', ['E01']).passed, checkRelevanceFloor(ctx, 'Many duplicate reports waste mornings.', ['E01']).passed,
    checkGeneralisation(ctx, 'Many duplicate reports waste mornings.', ['E01']).passed], [true, true, false]);
});
