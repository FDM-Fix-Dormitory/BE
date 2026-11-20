import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Pool } from 'mysql2/promise';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { MysqlManagementRepository } from '../src/repository.js';
import { MysqlAuthReportRepository } from '../src/auth-report-repository.js';
import { sessionResolver } from '../src/auth.js';
import { MAX_IMAGE_BYTES } from '../src/auth-report-routes.js';
import { temporaryMysql } from './temporary-mysql.js';

// 1x1 PNG
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('auth and report creation against isolated MySQL', { concurrency: false }, () => {
  let db: Pool;
  let app: Express;
  let cleanup: () => Promise<void>;
  const base = '/api/v1';
  const image = png();
  const tokens: Record<string, string> = {};
  const bearer = (user: string) => `Bearer ${tokens[user]}`;

  const login = (loginId: string, password = `${loginId}-pw`) =>
    request(app).post(`${base}/auth/sessions`).send({ loginId, password });
  const createReport = (body: Record<string, unknown>, user = 'student') =>
    request(app).post(`${base}/reports`).set('Authorization', bearer(user)).send(body);
  const common = { scope: 'COMMON', title: '3층 세탁기 고장', location: '기숙사 3층 세탁실', facilityType: 'WASHING_MACHINE', description: '작동하지 않습니다' };
  const room = { scope: 'ROOM', title: '전등 고장', location: '2층', roomNumber: '201', facilityType: 'LIGHT', description: '불이 안 켜집니다' };
  const upload = (reportId: string, user = 'student', files: Buffer[] = [image]) => {
    let req = request(app).post(`${base}/reports/${reportId}/images`).set('Authorization', bearer(user));
    for (const [i, file] of files.entries()) req = req.attach('images', file, { filename: `photo${i}.png`, contentType: 'image/png' });
    return req;
  };

  before(async () => {
    const fixture = await temporaryMysql();
    db = fixture.pool;
    cleanup = fixture.cleanup;
    const authRepository = new MysqlAuthReportRepository(db);
    app = createApp(new MysqlManagementRepository(db), sessionResolver(authRepository), undefined, authRepository);
  });
  after(async () => { await cleanup?.(); });
  beforeEach(async () => {
    for (const table of ['notifications', 'confirmations', 'report_images', 'reports', 'sessions', 'users']) await db.query(`DELETE FROM ${table}`);
    for (const id of ['student', 'other', 'admin']) {
      await db.execute('INSERT INTO users (id, role, display_name, login_id, password_hash) VALUES (?, ?, ?, ?, ?)',
        [id, id === 'admin' ? 'ADMIN' : 'STUDENT', `${id} 이름`, id, await bcrypt.hash(`${id}-pw`, 4)]);
    }
    await db.execute("INSERT INTO users (id, role, display_name) VALUES ('nologin', 'STUDENT', '로그인 불가')");
    for (const id of ['student', 'other', 'admin']) {
      const res = await login(id);
      assert.equal(res.status, 201);
      tokens[id] = res.body.data.token;
    }
  });

  describe('POST /auth/sessions', () => {
    test('issues an opaque bearer token stored only as a hash', async () => {
      const res = await login('student');
      assert.equal(res.status, 201);
      assert.equal(res.body.data.tokenType, 'Bearer');
      assert.match(res.body.data.token, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(res.body.data.user, { id: 'student', role: 'STUDENT', displayName: 'student 이름' });
      assert.ok(Date.parse(res.body.data.expiresAt) > Date.now());
      const [rows] = await db.query('SELECT token_hash FROM sessions WHERE token_hash = ?', [res.body.data.token]);
      assert.equal((rows as unknown[]).length, 0, 'raw token must not be stored');
    });

    test('wrong password, unknown and credential-less accounts get the same 401', async () => {
      const wrong = await login('student', 'nope');
      const unknown = await login('ghost', 'nope');
      const noCredentials = await login('nologin', 'nope');
      for (const res of [wrong, unknown, noCredentials]) {
        assert.equal(res.status, 401);
        assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      }
      assert.deepEqual(wrong.body, unknown.body);
    });

    test('rejects invalid bodies and media types', async () => {
      const missing = await request(app).post(`${base}/auth/sessions`).send({ loginId: 'student' });
      assert.equal(missing.status, 422);
      assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
      assert.ok(missing.body.error.details.some((d: { field: string }) => d.field === 'password'));
      const extra = await request(app).post(`${base}/auth/sessions`).send({ loginId: 'student', password: 'student-pw', role: 'ADMIN' });
      assert.equal(extra.status, 422);
      // 25자 한글은 75바이트로 bcrypt 한계(72바이트)를 넘습니다.
      const tooLong = await request(app).post(`${base}/auth/sessions`).send({ loginId: 'student', password: '가'.repeat(25) });
      assert.equal(tooLong.status, 422);
      const form = await request(app).post(`${base}/auth/sessions`).type('form').send('loginId=student&password=student-pw');
      assert.equal(form.status, 415);
    });
  });

  describe('logout', () => {
    for (const [method, path] of [['post', '/auth/sessions/me/delete'], ['delete', '/auth/sessions/current']] as const) {
      test(`${method.toUpperCase()} ${path} revokes only the current session`, async () => {
        const second = (await login('student')).body.data.token;
        const res = await request(app)[method](base + path).set('Authorization', bearer('student'));
        assert.equal(res.status, 204);
        assert.equal(res.text, '');
        assert.equal((await request(app).get(`${base}/me`).set('Authorization', bearer('student'))).status, 401);
        // 관리 API도 같은 세션 검증을 사용하므로 철회된 토큰은 거부됩니다.
        assert.equal((await request(app).get(`${base}/reports`).set('Authorization', bearer('student'))).status, 401);
        assert.equal((await request(app).get(`${base}/me`).set('Authorization', `Bearer ${second}`)).status, 200);
        assert.equal((await request(app)[method](base + path).set('Authorization', bearer('student'))).status, 401);
      });
    }

    test('requires a session', async () => {
      assert.equal((await request(app).post(`${base}/auth/sessions/me/delete`)).status, 401);
      assert.equal((await request(app).delete(`${base}/auth/sessions/current`).set('Authorization', 'Bearer not-a-real-token-123')).status, 401);
    });
  });

  describe('GET /me', () => {
    test('returns the session user for students and admins', async () => {
      const res = await request(app).get(`${base}/me`).set('Authorization', bearer('admin'));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { data: { id: 'admin', role: 'ADMIN', displayName: 'admin 이름' } });
      assert.equal(res.headers['cache-control'], 'private, no-store');
    });

    test('rejects missing, malformed and expired sessions', async () => {
      assert.equal((await request(app).get(`${base}/me`)).status, 401);
      assert.equal((await request(app).get(`${base}/me`).set('Authorization', tokens.student!)).status, 401);
      await db.query('UPDATE sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)');
      const expired = await request(app).get(`${base}/me`).set('Authorization', bearer('student'));
      assert.equal(expired.status, 401);
      assert.equal(expired.body.error.code, 'UNAUTHORIZED');
    });
  });

  describe('POST /reports', () => {
    test('creates common and room reports visible through management APIs', async () => {
      const res = await createReport({ ...common, title: '  앞뒤 공백  ' });
      assert.equal(res.status, 201);
      const data = res.body.data;
      assert.equal(data.title, '앞뒤 공백');
      assert.equal(data.status, 'RECEIVED');
      assert.equal(data.roomNumber, null);
      assert.equal(data.reporterId, 'student');
      assert.equal(data.sameIssueCount, 0);
      assert.deepEqual(data.images, []);
      const list = await request(app).get(`${base}/reports`).set('Authorization', bearer('other'));
      assert.deepEqual(list.body.data.map((r: { id: string }) => r.id), [data.id]);

      const roomRes = await createReport(room);
      assert.equal(roomRes.status, 201);
      assert.equal(roomRes.body.data.roomNumber, '201');
      assert.equal((await request(app).get(`${base}/reports/${roomRes.body.data.id}`).set('Authorization', bearer('other'))).status, 404);
    });

    test('validates scope/room consistency, enums and unknown fields with 422', async () => {
      for (const body of [
        { ...room, roomNumber: undefined }, { ...common, roomNumber: '301' }, { ...room, roomNumber: '01' },
        { ...common, facilityType: 'TV' }, { ...common, title: '   ' }, { ...common, status: 'COMPLETED' },
        { ...common, reporterId: 'other' },
      ]) {
        const res = await createReport(body);
        assert.equal(res.status, 422, JSON.stringify(body));
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      }
      const [rows] = await db.query('SELECT id FROM reports');
      assert.equal((rows as unknown[]).length, 0);
    });

    test('only students can create reports and JSON is required', async () => {
      assert.equal((await createReport(common, 'admin')).status, 403);
      assert.equal((await request(app).post(`${base}/reports`).send(common)).status, 401);
      const text = await request(app).post(`${base}/reports`).set('Authorization', bearer('student')).type('text').send('hi');
      assert.equal(text.status, 415);
    });
  });

  describe('GET /me/reports', () => {
    test('lists only my reports, newest first, with filters and cursor', async () => {
      const ids: string[] = [];
      for (const title of ['첫째', '둘째', '셋째']) ids.push((await createReport({ ...common, title })).body.data.id);
      await createReport(common, 'other');
      await db.execute("UPDATE reports SET status = 'COMPLETED' WHERE id = ?", [ids[0]!]);

      const first = await request(app).get(`${base}/me/reports?limit=2`).set('Authorization', bearer('student'));
      assert.equal(first.status, 200);
      assert.deepEqual(first.body.data.map((r: { title: string }) => r.title), ['셋째', '둘째']);
      assert.equal(first.body.page.hasMore, true);
      const second = await request(app).get(`${base}/me/reports?limit=2&cursor=${first.body.page.nextCursor}`).set('Authorization', bearer('student'));
      assert.deepEqual(second.body.data.map((r: { title: string }) => r.title), ['첫째']);
      assert.deepEqual(second.body.page, { nextCursor: null, hasMore: false });

      const done = await request(app).get(`${base}/me/reports?status=COMPLETED`).set('Authorization', bearer('student'));
      assert.deepEqual(done.body.data.map((r: { id: string }) => r.id), [ids[0]]);
      // 다른 사용자의 커서는 사용할 수 없습니다.
      const stolen = await request(app).get(`${base}/me/reports?cursor=${first.body.page.nextCursor}`).set('Authorization', bearer('other'));
      assert.equal(stolen.status, 400);
    });

    test('rejects bad queries and admins', async () => {
      assert.equal((await request(app).get(`${base}/me/reports?status=DONE`).set('Authorization', bearer('student'))).status, 400);
      assert.equal((await request(app).get(`${base}/me/reports?limit=101`).set('Authorization', bearer('student'))).status, 400);
      assert.equal((await request(app).get(`${base}/me/reports?foo=1`).set('Authorization', bearer('student'))).status, 400);
      assert.equal((await request(app).get(`${base}/me/reports`).set('Authorization', bearer('admin'))).status, 403);
      assert.equal((await request(app).get(`${base}/me/reports`)).status, 401);
    });
  });

  describe('POST /reports/{reportId}/images and GET /report-images/{imageId}', () => {
    test('stores images in MySQL and serves them through report detail URLs', async () => {
      const reportId = (await createReport(common)).body.data.id;
      const res = await upload(reportId, 'student', [image, image]);
      assert.equal(res.status, 201);
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.data[0].contentType, 'image/png');
      assert.equal(res.body.data[0].url, `/api/v1/report-images/${res.body.data[0].id}`);

      const detail = await request(app).get(`${base}/reports/${reportId}`).set('Authorization', bearer('other'));
      assert.deepEqual(detail.body.data.images.map((i: { id: string }) => i.id).sort(), res.body.data.map((i: { id: string }) => i.id).sort());

      const file = await request(app).get(res.body.data[0].url).set('Authorization', bearer('other')).buffer(true);
      assert.equal(file.status, 200);
      assert.equal(file.headers['content-type'], 'image/png');
      assert.equal(file.headers['x-content-type-options'], 'nosniff');
      assert.ok(Buffer.compare(file.body as Buffer, image) === 0);
      assert.equal((await request(app).get(res.body.data[0].url)).status, 401);
    });

    test('room report images are hidden like the report itself', async () => {
      const reportId = (await createReport(room)).body.data.id;
      const url = (await upload(reportId)).body.data[0].url;
      const hidden = await request(app).get(url).set('Authorization', bearer('other'));
      const missing = await request(app).get(`${base}/report-images/missing`).set('Authorization', bearer('other'));
      assert.equal(hidden.status, 404);
      assert.deepEqual(hidden.body, missing.body);
      assert.equal((await request(app).get(url).set('Authorization', bearer('admin'))).status, 200);
      assert.equal((await upload(reportId, 'other')).status, 404);
    });

    test('only the reporter can upload', async () => {
      const reportId = (await createReport(common)).body.data.id;
      assert.equal((await upload(reportId, 'other')).status, 403);
      assert.equal((await upload(reportId, 'admin')).status, 403);
      assert.equal((await upload('missing')).status, 404);
    });

    test('validates file content, count, size and media type', async () => {
      const reportId = (await createReport(common)).body.data.id;
      const fake = await upload(reportId, 'student', [Buffer.from('<svg onload=alert(1)>')]);
      assert.equal(fake.status, 422);
      assert.equal(fake.body.error.details[0].reason, 'INVALID_IMAGE');
      const none = await request(app).post(`${base}/reports/${reportId}/images`).set('Authorization', bearer('student')).field('x', 'y');
      assert.equal(none.status, 400);
      const empty = await request(app).post(`${base}/reports/${reportId}/images`).set('Authorization', bearer('student'))
        .attach('other', image, 'a.png');
      assert.equal(empty.status, 400);
      assert.equal((await upload(reportId, 'student', Array(6).fill(image))).status, 400);
      const big = Buffer.concat([image, Buffer.alloc(MAX_IMAGE_BYTES)]);
      assert.equal((await upload(reportId, 'student', [big])).status, 413);
      const exact = Buffer.concat([image, Buffer.alloc(MAX_IMAGE_BYTES - image.length)]);
      assert.equal((await upload(reportId, 'student', [exact])).status, 201);
      const malformed = await request(app).post(`${base}/reports/${reportId}/images`).set('Authorization', bearer('student'))
        .set('Content-Type', 'multipart/form-data').send('--x\r\n');
      assert.equal(malformed.status, 400);
      const truncated = await request(app).post(`${base}/reports/${reportId}/images`).set('Authorization', bearer('student'))
        .set('Content-Type', 'multipart/form-data; boundary=x').send('--x\r\nContent-Disposition: form-data; name="images"; filename="a.png"\r\n\r\nabc');
      assert.equal(truncated.status, 400);
      const json = await request(app).post(`${base}/reports/${reportId}/images`).set('Authorization', bearer('student')).send({});
      assert.equal(json.status, 415);

      assert.equal((await upload(reportId, 'student', Array(5).fill(image))).status, 201);
      assert.equal((await upload(reportId, 'student', Array(4).fill(image))).status, 201);
      const over = await upload(reportId);
      assert.equal(over.status, 422);
      assert.equal(over.body.error.details[0].reason, 'TOO_MANY');
      const [rows] = await db.query('SELECT COUNT(*) AS n FROM report_images');
      assert.equal(Number((rows as { n: number }[])[0]!.n), 10);
    });
  });
});
