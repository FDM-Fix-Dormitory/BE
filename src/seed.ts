import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';

// Manual development fixture. Existing records and credentials are never changed.
try {
  if (config.NODE_ENV !== 'development') throw new Error('Seed is available only with NODE_ENV=development.');
  const connection = await pool.getConnection();
  const accounts: { name: string; role: string; token: string }[] = [];
  try {
    await connection.beginTransaction();
    const users: string[] = [];
    for (const [name, role] of [['신고 학생', 'STUDENT'], ['확인 학생', 'STUDENT'], ['관리자', 'ADMIN']] as const) {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      users.push(id);
      await connection.execute('INSERT INTO users (id, role, display_name) VALUES (?, ?, ?)', [id, role, name]);
      await connection.execute(`INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 HOUR))`, [createHash('sha256').update(token).digest('hex'), id]);
      accounts.push({ name, role, token });
    }
    const reportId = randomUUID();
    await connection.execute(`INSERT INTO reports (id, reporter_id, scope, title, location, facility_type, description)
      VALUES (?, ?, 'COMMON', '3층 세탁기 고장', '기숙사 3층 세탁실', 'WASHING_MACHINE', '세탁기가 작동하지 않습니다.')`, [reportId, users[0]!]);
    await connection.commit();
    console.log('개발용 데이터 생성 완료. 토큰은 8시간 뒤 만료됩니다. 외부에 공유하거나 커밋하지 마세요.');
    console.log(JSON.stringify({ reportId, accounts }, null, 2));
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
} finally { await pool.end(); }
