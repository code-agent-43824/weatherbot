import assert from 'node:assert/strict';
import test from 'node:test';

import { commuteCatchUpMinutes, scenarioSendDecision } from '../src/schedule.js';

const today = '2026-09-06';
const commute = (extra = {}) => ({ mode: 'regular', settings: { time: '08:30' }, lastSentDate: null, ...extra });
const trip = (extra = {}) => ({ mode: 'planned', settings: { time: '08:30', tripDate: '2026-09-20' }, lastSentDate: null, ...extra });

test('waits until the scheduled minute arrives', () => {
  assert.equal(scenarioSendDecision(commute(), today, '08:29'), 'wait');
  assert.equal(scenarioSendDecision(commute(), today, '00:00'), 'wait');
});

test('sends on the scheduled minute', () => {
  assert.equal(scenarioSendDecision(commute(), today, '08:30'), 'send');
});

test('still sends when the round overran the minute', () => {
  // Ровно та потеря, ради которой всё это: раньше 08:31 означало «в этот день нет».
  assert.equal(scenarioSendDecision(commute(), today, '08:31'), 'send');
  assert.equal(scenarioSendDecision(commute(), today, '09:29'), 'send');
});

test('closes the day instead of sending a stale commute forecast', () => {
  assert.equal(scenarioSendDecision(commute(), today, '09:30'), 'send', 'граница окна догона');
  assert.equal(scenarioSendDecision(commute(), today, '09:31'), 'skip');
  assert.equal(scenarioSendDecision(commute(), today, '23:59'), 'skip');
});

test('lets a planned trip catch up however late it is', () => {
  assert.equal(scenarioSendDecision(trip(), today, '23:59'), 'send');
  assert.equal(scenarioSendDecision(trip(), today, '08:29'), 'wait');
});

test('does not send twice on the same day', () => {
  assert.equal(scenarioSendDecision(commute({ lastSentDate: today }), today, '08:30'), 'done');
  assert.equal(scenarioSendDecision(trip({ lastSentDate: today }), today, '23:59'), 'done');
  assert.equal(scenarioSendDecision(commute({ lastSentDate: '2026-09-05' }), today, '08:30'), 'send');
});

test('waits when there is no usable time', () => {
  assert.equal(scenarioSendDecision({ mode: 'regular', settings: {} }, today, '08:30'), 'wait');
  assert.equal(scenarioSendDecision({ mode: 'regular' }, today, '08:30'), 'wait');
  assert.equal(scenarioSendDecision(commute(), today, 'не время'), 'wait');
});

test('reads midnight the same whichever way the clock prints it', () => {
  const midnight = commute({ settings: { time: '00:00' } });

  assert.equal(scenarioSendDecision(midnight, today, '00:00'), 'send');
  assert.equal(scenarioSendDecision(midnight, today, '24:00'), 'send');
});

test('the catch-up window is a single named number', () => {
  const late = (minutes) => {
    const at = 8 * 60 + 30 + minutes;
    return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
  };

  assert.equal(scenarioSendDecision(commute(), today, late(commuteCatchUpMinutes)), 'send');
  assert.equal(scenarioSendDecision(commute(), today, late(commuteCatchUpMinutes + 1)), 'skip');
});
