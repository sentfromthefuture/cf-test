import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBlueprintEntitlement, readBearerToken, readDailyBlueprintLimit } from '../access.ts';

const now = Date.parse('2026-11-18T12:00:00Z');

test('bearer parsing accepts only a single non-empty token', () => {
  assert.equal(readBearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(readBearerToken('bearer token'), 'token');
  assert.equal(readBearerToken(null), null);
  assert.equal(readBearerToken('Basic abc'), null);
  assert.equal(readBearerToken('Bearer one two'), null);
});

test('only active Pro and Business subscriptions are entitled', () => {
  assert.deepEqual(checkBlueprintEntitlement({ plan: 'Pro', status: 'active', current_period_end: null }, now), { allowed: true, plan: 'Pro' });
  assert.deepEqual(checkBlueprintEntitlement({ plan: 'Business', status: 'active', current_period_end: null }, now), { allowed: true, plan: 'Business' });
  assert.deepEqual(checkBlueprintEntitlement({ plan: 'Free', status: 'active', current_period_end: null }, now), { allowed: false, reason: 'unsupported_plan' });
  assert.deepEqual(checkBlueprintEntitlement({ plan: 'Pro', status: 'inactive', current_period_end: null }, now), { allowed: false, reason: 'inactive_subscription' });
  assert.deepEqual(checkBlueprintEntitlement(null, now), { allowed: false, reason: 'missing_subscription' });
});

test('cancelled subscription remains entitled only through a valid future period end', () => {
  assert.equal(checkBlueprintEntitlement({ plan: 'Pro', status: 'cancelled', current_period_end: '2026-11-19T00:00:00Z' }, now).allowed, true);
  assert.equal(checkBlueprintEntitlement({ plan: 'Pro', status: 'cancelled', current_period_end: '2026-11-18T12:00:00Z' }, now).allowed, false);
  assert.equal(checkBlueprintEntitlement({ plan: 'Pro', status: 'cancelled', current_period_end: 'not-a-date' }, now).allowed, false);
});

test('daily limits require explicit positive safe integer configuration', () => {
  assert.equal(readDailyBlueprintLimit('1'), 1);
  assert.equal(readDailyBlueprintLimit('20'), 20);
  for (const value of [undefined, '', '0', '-1', '1.5', '01', 'Infinity', '9007199254740992']) {
    assert.equal(readDailyBlueprintLimit(value), null);
  }
});
