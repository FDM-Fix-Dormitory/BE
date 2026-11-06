import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { unavailableRepository } from './fixtures.js';

const app = createApp(unavailableRepository);

test('unknown routes return JSON with a generated request ID', async () => {
  const res = await request(app).get('/missing');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.match(res.headers['x-request-id'] ?? '', /^[a-f0-9-]{36}$/);
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('malformed JSON returns a client error without a stack trace', async () => {
  const res = await request(app).post('/reports').set('Content-Type', 'application/json').send('{');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'BAD_REQUEST');
  assert.equal(res.body.error.stack, undefined);
});

test('oversized JSON returns 413', async () => {
  const res = await request(app).post('/reports').send({ value: 'x'.repeat(1024 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('all six APIs require authentication', async () => {
  for (const [method, path] of [
    ['get', '/reports'], ['get', '/reports/report_1'], ['get', '/admin/reports'],
    ['patch', '/admin/reports/report_1/status'], ['post', '/reports/report_1/confirmations'], ['get', '/me/notifications'],
  ] as const) {
    const res = await request(app)[method](`/api/v1${path}`);
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
    assert.equal(res.headers['cache-control'], 'private, no-store');
  }
});
