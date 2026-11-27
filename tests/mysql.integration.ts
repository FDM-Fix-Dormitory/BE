import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { MysqlManagementRepository } from '../src/repository.js';
import { temporaryMysql } from './temporary-mysql.js';

describe('report management against isolated MySQL', { concurrency: false }, () => {
  let db: Pool;
  let app: Express;
  let cleanup: () => Promise<void>;
  const tokens = Object.fromEntries(['reporter', 'student', 'other', 'admin'].map(id => [id, randomBytes(32).toString('base64url')]));
  const auth = (id: string) => `Bearer ${tokens[id]}`;
  const base = '/api/v1';
  const get = (path: string, user = 'student') => request(app).get(base + path).set('Authorization', auth(user));
  const confirm = (id = 'common', user = 'student') => request(app).post(`${base}/reports/${id}/confirmations`).set('Authorization', auth(user));
  const status = (value: string, id = 'common', user = 'admin') => request(app)
    .patch(`${base}/admin/reports/${id}/status`).set('Authorization', auth(user)).send({ status: value });
  const scalar = async (sql: string, params: unknown[] = []) => {
    const [rows] = await db.query<RowDataPacket[]>(sql, params);
    return Number(Object.values(rows[0]!)[0]);
  };

  before(async () => {
    const fixture = await temporaryMysql();
    db = fixture.pool;
    cleanup = fixture.cleanup;
    app = createApp(new MysqlManagementRepository(db));
  });
  after(async () => { await cleanup?.(); });
  beforeEach(async () => {
    // This pool only targets the newly created, disposable dom_test database.
    for (const table of ['notifications', 'confirmations', 'report_images', 'reports', 'sessions', 'users']) await db.query(`DELETE FROM ${table}`);
    for (const id of ['reporter', 'student', 'other', 'admin']) {
      await db.execute('INSERT INTO users (id, role, display_name) VALUES (?, ?, ?)', [id, id === 'admin' ? 'ADMIN' : 'STUDENT', id]);
      await db.execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))',
        [createHash('sha256').update(tokens[id]!).digest('hex'), id]);
    }
    for (const [id, scope, reporter, room, created] of [
      ['common', 'COMMON', 'reporter', null, '2026-10-21 00:00:00.000'],
      ['common_new', 'COMMON', 'other', null, '2026-10-22 00:00:00.000'],
      ['room', 'ROOM', 'reporter', '201', '2026-10-23 00:00:00.000'],
    ] as const) {
      await db.execute(`INSERT INTO reports (id, reporter_id, scope, title, location, room_number, facility_type, description, created_at, updated_at)
        VALUES (?, ?, ?, '고장 신고', '기숙사 3층', ?, 'LIGHT', '불이 안 켜집니다', ?, ?)`, [id, reporter, scope, room, created, created]);
    }
  });

  test('public list excludes room reports and private fields, including pagination', async () => {
    const first = await get('/reports?limit=1');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.map((r: { id: string }) => r.id), ['common_new']);
    assert.equal(first.body.page.hasMore, true);
    assert.equal(first.body.data[0].reporterId, undefined);
    assert.equal(first.body.data[0].roomNumber, undefined);
    assert.equal(first.body.data[0].description, undefined);
    assert.equal(first.body.data[0].createdAt, '2026-10-22T00:00:00.000Z');
    const second = await get(`/reports?limit=1&cursor=${first.body.page.nextCursor}`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data.map((r: { id: string }) => r.id), ['common']);
    assert.deepEqual(second.body.page, { nextCursor: null, hasMore: false });
    const admin = await get('/reports', 'admin');
    assert.ok(admin.body.data.every((r: { scope: string; roomNumber?: string }) => r.scope === 'COMMON' && r.roomNumber === undefined));
  });

  test('room detail returns identical 404 to missing for unrelated students', async () => {
    const hidden = await get('/reports/room');
    const missing = await get('/reports/missing');
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, missing.body);
    const owner = await get('/reports/room', 'reporter');
    assert.equal(owner.status, 200);
    assert.equal(owner.body.data.roomNumber, '201');
    assert.equal(owner.body.data.reporterId, 'reporter');
    assert.equal((await get('/reports/room', 'admin')).status, 200);
    const common = await get('/reports/common');
    assert.equal(common.status, 200);
    assert.equal(common.body.data.reporterId, undefined);
    assert.equal(common.body.data.isConfirmedByMe, false);
    assert.deepEqual(common.body.data.images, []);
  });

  test('administrator endpoints enforce database role before parsing or writing', async () => {
    assert.equal((await get('/admin/reports')).status, 403);
    assert.equal((await status('COMPLETED', 'common', 'student')).status, 403);
    assert.equal(await scalar("SELECT COUNT(*) FROM reports WHERE status = 'RECEIVED'"), 3);
    await db.execute("UPDATE users SET role = 'STUDENT' WHERE id = 'admin'");
    assert.equal((await get('/admin/reports', 'admin')).status, 403);
  });

  test('missing, forged, revoked and expired sessions are rejected', async () => {
    assert.equal((await request(app).get(`${base}/reports`)).status, 401);
    assert.equal((await request(app).get(`${base}/reports`).set('Authorization', `Bearer ${'x'.repeat(32)}`)).status, 401);
    await db.execute("UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = 'student'");
    assert.equal((await get('/reports')).status, 401);
    await db.execute("UPDATE sessions SET expires_at = '2000-01-01', revoked_at = NULL WHERE user_id = 'student'");
    assert.equal((await get('/reports')).status, 401);
  });

  test('strict query and cursor validation rejects filters, spoofed identity, arrays and injection', async () => {
    for (const query of ['scope=ROOM', 'userId=reporter', 'role=ADMIN', 'status=FAKE', 'limit=0', 'limit=101', 'limit=1.5', 'limit=abc', 'status=RECEIVED&status=COMPLETED', 'cursor=garbage']) {
      assert.equal((await get(`/reports?${query}`)).status, 400, query);
    }
    assert.equal((await get('/reports/invalid%27id')).status, 400);
    assert.equal((await get('/admin/reports?sort=anything', 'admin')).status, 400);
    const first = await get('/reports?limit=1');
    assert.equal((await get(`/reports?status=COMPLETED&cursor=${first.body.page.nextCursor}`)).status, 400);
    assert.equal((await get(`/admin/reports?cursor=${first.body.page.nextCursor}`, 'admin')).status, 400);
  });

  test('admin filters and sort options return all eligible reports with stable tie breaks', async () => {
    const all = await get('/admin/reports', 'admin');
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 3);
    assert.equal(all.body.data[0].roomNumber, '201');
    assert.deepEqual((await get('/admin/reports?scope=ROOM', 'admin')).body.data.map((r: { id: string }) => r.id), ['room']);
    await confirm();
    const popular = await get('/admin/reports?sort=sameIssueCount_desc&limit=1', 'admin');
    assert.equal(popular.body.data[0].id, 'common');
    assert.equal(popular.body.data[0].sameIssueCount, 1);
    const next = await get(`/admin/reports?sort=sameIssueCount_desc&limit=1&cursor=${popular.body.page.nextCursor}`, 'admin');
    assert.equal(next.body.data[0].id, 'room');
    const old = await get('/admin/reports?sort=createdAt_asc&limit=1', 'admin');
    assert.equal(old.body.data[0].id, 'common');
    assert.equal((await get(`/admin/reports?sort=createdAt_asc&limit=1&cursor=${old.body.page.nextCursor}`, 'admin')).body.data[0].id, 'common_new');
    assert.deepEqual((await get('/reports?status=COMPLETED')).body.data, []);
  });

  test('concurrent duplicate confirmations create exactly one row', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => confirm()));
    assert.equal(results.filter(res => res.status === 201).length, 1);
    assert.equal(results.filter(res => res.status === 200).length, 11);
    assert.ok(results.every(res => res.body.data.sameIssueCount === 1));
    assert.equal(await scalar('SELECT COUNT(*) FROM confirmations'), 1);
    const detail = await get('/reports/common');
    assert.equal(detail.body.data.isConfirmedByMe, true);
    assert.equal(detail.body.data.sameIssueCount, 1);
    assert.equal((await get('/reports')).body.data.find((r: { id: string }) => r.id === 'common').sameIssueCount, 1);
  });

  test('different students count separately; role, scope, owner and body rules hold', async () => {
    assert.equal((await confirm()).status, 201);
    assert.equal((await confirm('common', 'other')).body.data.sameIssueCount, 2);
    assert.equal((await confirm('common', 'admin')).status, 403);
    assert.equal((await confirm('common', 'reporter')).status, 403);
    assert.equal((await confirm('room', 'student')).status, 404);
    assert.equal((await confirm('room', 'reporter')).status, 403);
    assert.equal((await confirm('missing')).status, 404);
    assert.equal((await confirm().send({ userId: 'other' })).status, 400);
    assert.equal((await confirm().type('text').send('unexpected')).status, 400);
    await status('COMPLETED', 'common_new');
    assert.equal((await confirm('common_new', 'reporter')).status, 201);
  });

  test('status changes notify reporter and confirmers once, and persist across app instances', async () => {
    await confirm();
    const res = await status('REPAIRING');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'REPAIRING');
    assert.ok(!Number.isNaN(Date.parse(res.body.data.updatedAt)));
    assert.equal(await scalar('SELECT COUNT(*) FROM notifications'), 2);
    const again = await status('REPAIRING');
    assert.equal(again.body.data.updatedAt, res.body.data.updatedAt);
    assert.equal(await scalar('SELECT COUNT(*) FROM notifications'), 2);
    const list = await get('/me/notifications');
    assert.equal(list.body.data[0].previousStatus, 'RECEIVED');
    assert.equal(list.body.data[0].newStatus, 'REPAIRING');
    assert.equal(list.body.data[0].read, false);
    assert.equal((await get('/me/notifications', 'reporter')).body.data.length, 1);
    assert.equal((await get('/me/notifications', 'other')).body.data.length, 0);
    const secondApp = createApp(new MysqlManagementRepository(db));
    const detail = await request(secondApp).get(`${base}/reports/common`).set('Authorization', auth('student'));
    assert.equal(detail.body.data.status, 'REPAIRING');
    assert.equal((await get('/reports?status=REPAIRING')).body.data.length, 1);
  });

  test('simultaneous same-status updates emit one event per recipient', async () => {
    await confirm();
    const results = await Promise.all(Array.from({ length: 8 }, () => status('REVIEWING')));
    assert.ok(results.every(res => res.status === 200));
    assert.equal(await scalar('SELECT COUNT(*) FROM notifications'), 2);
  });

  test('room status changes notify only its reporter', async () => {
    assert.equal((await status('COMPLETED', 'room')).status, 200);
    assert.equal((await get('/me/notifications', 'reporter')).body.data[0].reportId, 'room');
    assert.equal((await get('/me/notifications')).body.data.length, 0);
    assert.equal((await get('/me/notifications', 'other')).body.data.length, 0);
  });

  test('notification insertion failure rolls back the status update', async () => {
    await db.query("CREATE TRIGGER reject_notification BEFORE INSERT ON notifications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test failure'");
    try {
      const res = await status('COMPLETED');
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, 'INTERNAL_ERROR');
      assert.equal(res.body.error.message.includes('test failure'), false);
      assert.equal((await get('/reports/common')).body.data.status, 'RECEIVED');
      assert.equal(await scalar('SELECT COUNT(*) FROM notifications'), 0);
    } finally { await db.query('DROP TRIGGER reject_notification'); }
  });

  test('status request rejects invalid enums, extra fields, missing bodies and wrong media types', async () => {
    assert.equal((await status('BOGUS')).status, 422);
    assert.equal((await status('REPAIRING', 'missing')).status, 404);
    const path = `${base}/admin/reports/common/status`;
    assert.equal((await request(app).patch(path).set('Authorization', auth('admin')).send({ status: 'REPAIRING', role: 'ADMIN' })).status, 422);
    assert.equal((await request(app).patch(path).set('Authorization', auth('admin')).send({})).status, 422);
    assert.equal((await request(app).patch(path).set('Authorization', auth('admin')).type('text').send('REPAIRING')).status, 415);
  });

  test('notification pagination, unreadOnly and user isolation hold', async () => {
    await confirm();
    await status('REVIEWING');
    await status('REPAIRING');
    const first = await get('/me/notifications?limit=1');
    assert.equal(first.status, 200);
    assert.equal(first.body.page.hasMore, true);
    const second = await get(`/me/notifications?limit=1&cursor=${first.body.page.nextCursor}`);
    assert.equal(second.status, 200);
    assert.notEqual(first.body.data[0].id, second.body.data[0].id);
    assert.equal(second.body.page.hasMore, false);
    assert.equal((await get(`/me/notifications?cursor=${first.body.page.nextCursor}`, 'other')).status, 400);
    await db.execute('UPDATE notifications SET read_at = UTC_TIMESTAMP(3) WHERE id = ?', [first.body.data[0].id]);
    assert.equal((await get('/me/notifications?unreadOnly=true')).body.data.length, 1);
    assert.equal((await get('/me/notifications?unreadOnly=false')).body.data.length, 2);
    assert.equal((await get('/me/notifications?unreadOnly=1')).status, 400);
    assert.equal((await get('/me/notifications?userId=reporter')).status, 400);
    assert.equal((await get('/me/notifications', 'admin')).status, 403);
  });
});
