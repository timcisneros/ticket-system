#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  CANCELLATION_AUTHORITY_VERSION,
  TicketCancellationAuthorityError,
  buildCancellationAuthority,
  cancellationAuthoritySemanticallyEqual,
  normalizeCancellationAuthority
} = require('../runtime/ticket-cancellation-authority-contract');

let assertions = 0;
function test(label, fn) {
  fn();
  assertions += 1;
  console.log(`  ok ${label}`);
}

const authority = buildCancellationAuthority({
  ticketId: 7,
  authoritySource: 'operator',
  requestedBy: 'alice',
  reason: 'intentional abandonment',
  committedAt: '2026-08-20T00:00:00.000Z'
});

console.log('Ticket cancellation authority contract');

test('builds the versioned Ticket-owned authority shape', () => {
  assert.deepEqual(authority, {
    version: CANCELLATION_AUTHORITY_VERSION,
    ticketId: 7,
    authoritySource: 'operator',
    requestedBy: 'alice',
    reason: 'intentional abandonment',
    committedAt: '2026-08-20T00:00:00.000Z'
  });
});

test('normalizes and freezes authority values', () => {
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(normalizeCancellationAuthority(authority).ticketId, 7);
});

test('binds authority to its expected Ticket', () => {
  assert.throws(
    () => normalizeCancellationAuthority(authority, { expectedTicketId: 8 }),
    error => error.code === 'TICKET_CANCELLATION_AUTHORITY_BINDING_INVALID'
  );
});

test('rejects unsupported authority fields', () => {
  assert.throws(
    () => normalizeCancellationAuthority({ ...authority, mutable: true }),
    error => error.code === 'TICKET_CANCELLATION_AUTHORITY_INVALID'
  );
});

test('rejects unsupported versions', () => {
  assert.throws(
    () => normalizeCancellationAuthority({ ...authority, version: 2 }),
    error => error instanceof TicketCancellationAuthorityError
  );
});

test('rejects missing attribution and reason', () => {
  assert.throws(
    () => buildCancellationAuthority({ ticketId: 7, requestedBy: '', reason: '' }),
    error => error.code === 'TICKET_CANCELLATION_AUTHORITY_INVALID'
  );
});

test('rejects invalid timestamps', () => {
  assert.throws(
    () => normalizeCancellationAuthority({ ...authority, committedAt: 'not-a-time' }),
    error => error.code === 'TICKET_CANCELLATION_AUTHORITY_INVALID'
  );
});

test('semantic repeats ignore the original commit timestamp', () => {
  assert.equal(cancellationAuthoritySemanticallyEqual(authority, {
    ...authority,
    committedAt: '2026-08-20T00:01:00.000Z'
  }), true);
});

test('semantic changes are not idempotent', () => {
  assert.equal(cancellationAuthoritySemanticallyEqual(authority, {
    ...authority,
    reason: 'different reason'
  }), false);
});

test('Ticket identity remains part of semantic identity', () => {
  assert.equal(cancellationAuthoritySemanticallyEqual(authority, {
    ...authority,
    ticketId: 8
  }), false);
});

console.log(`  ${assertions} assertions passed`);
