import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) throw new Error("DB가 초기화되지 않았습니다. initDb()를 먼저 호출하세요");
  return pool;
}

async function initDb(env: NodeJS.ProcessEnv) {
  const base = {
    host: env.DB_HOST ?? "localhost",
    port: parseInt(env.DB_PORT ?? "3306"),
    user: env.DB_USER!,
    password: env.DB_PASSWORD ?? "",
    timezone: "Z" as const,
  };
  const database = env.DB_NAME!;

  // 데이터베이스가 없으면 생성
  const conn = await mysql.createConnection(base);
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, "")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.end();

  pool = mysql.createPool({ ...base, database, connectionLimit: 10 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      login_id      VARCHAR(50)  NOT NULL UNIQUE,
      password_hash VARCHAR(200) NOT NULL,
      role          ENUM('user','admin') NOT NULL DEFAULT 'user',
      display_name  VARCHAR(50)  NOT NULL,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id         CHAR(36)     NOT NULL PRIMARY KEY,
      author_id  CHAR(36)     NOT NULL,
      title      VARCHAR(100) NOT NULL,
      content    TEXT         NOT NULL,
      created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_reports_author (author_id, created_at),
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_images (
      id         CHAR(36)     NOT NULL PRIMARY KEY,
      report_id  CHAR(36)     NOT NULL,
      filename   VARCHAR(255) NOT NULL,
      mime_type  VARCHAR(50)  NOT NULL,
      size       INT UNSIGNED NOT NULL,
      data       MEDIUMBLOB   NOT NULL,
      created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_images_report (report_id),
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
    )`);
  await migrateReportImages(pool, database);
}

// 이전 스키마(파일 경로를 url 컬럼에 저장)에서 이미지 본문을 DB에 저장하는 스키마로 변경
async function migrateReportImages(pool: Pool, database: string) {
  const [cols] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'report_images'",
    [database],
  );
  const names = new Set(cols.map((c) => c.name as string));
  if (!names.has("url")) return;
  // 파일 본문이 없는 기존 행은 복구할 수 없으므로 삭제
  await pool.query("DELETE FROM report_images");
  await pool.query("ALTER TABLE report_images DROP COLUMN url");
  if (!names.has("data")) await pool.query("ALTER TABLE report_images ADD COLUMN data MEDIUMBLOB NOT NULL");
  console.log("report_images 테이블을 이미지 DB 저장 방식으로 변경했습니다");
}

export { getPool, initDb };
