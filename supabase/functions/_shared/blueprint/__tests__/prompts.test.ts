import test from 'node:test';
import assert from 'node:assert/strict';
import { BLUEPRINT_PASS_PROMPTS, BLUEPRINT_PROMPT_VERSION, blueprintSystemPrompt } from '../prompts.ts';

test('versioned pass prompts include the complete approved schema skeletons', () => {
  assert.equal(BLUEPRINT_PROMPT_VERSION, 'blueprint-prompt-v1');
  const a = blueprintSystemPrompt('A');
  const b = blueprintSystemPrompt('B');
  const c = blueprintSystemPrompt('C');
  for (const key of ['opportunity','market_evidence','personas','product','mvp','journeys','workflows','commercial']) assert.ok(a.includes(key));
  for (const key of ['architecture','database','tech_choices','foreign_keys','rls']) assert.ok(b.includes(key));
  for (const key of ['implementation','testing','risks','acceptance_criteria','validation_experiments']) assert.ok(c.includes(key));
  assert.ok(a.includes('evidence_refs'));
  assert.ok(a.includes('Willingness to pay'));
  assert.ok(!b.includes('EVIDENCE RULES'));
  assert.ok(!c.includes('EVIDENCE RULES'));
  assert.equal(BLUEPRINT_PASS_PROMPTS.A, a);
});

test('prompt sections are joined with actual line breaks', () => {
  for (const pass of ['A','B','C'] as const) {
    const prompt = blueprintSystemPrompt(pass);
    assert.ok(prompt.includes('\n\n'));
    assert.ok(!prompt.includes('\\n\\n'));
  }
});
