import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getPool } from "./db.js";
// BLOB은 무거우므로 목록 조회 시 제외할 컬럼 목록
const IMAGE_COLUMNS = "id, report_id, filename, mime_type, size, created_at";
// ---------- 비밀번호 해시 ----------
function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash)
        return false;
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(expected, actual);
}
// ---------- 행 → 객체 변환 ----------
function toUser(row) {
    return {
        id: row.id,
        loginId: row.login_id,
        passwordHash: row.password_hash,
        role: row.role,
        displayName: row.display_name,
    };
}
function toImage(row) {
    return {
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        size: row.size,
        url: `/api/v1/images/${row.id}`,
        createdAt: row.created_at.toISOString(),
    };
}
function toReport(row, images) {
    return {
        id: row.id,
        authorId: row.author_id,
        title: row.title,
        content: row.content,
        images,
        createdAt: row.created_at.toISOString(),
    };
}
// ---------- 사용자 ----------
async function createUser(loginId, password, displayName, role = "user") {
    const user = { id: randomUUID(), loginId, passwordHash: hashPassword(password), role, displayName };
    await getPool().execute("INSERT INTO users (id, login_id, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)", [user.id, user.loginId, user.passwordHash, user.role, user.displayName]);
    return user;
}
async function findUser(id) {
    const [rows] = await getPool().execute("SELECT * FROM users WHERE id = ?", [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
}
async function findUserByLoginId(loginId) {
    const [rows] = await getPool().execute("SELECT * FROM users WHERE login_id = ?", [loginId]);
    return rows[0] ? toUser(rows[0]) : undefined;
}
// ---------- 신고 ----------
async function createReport(authorId, title, content) {
    const id = randomUUID();
    await getPool().execute("INSERT INTO reports (id, author_id, title, content) VALUES (?, ?, ?, ?)", [
        id,
        authorId,
        title,
        content,
    ]);
    return (await findReport(id));
}
async function findReport(id) {
    const pool = getPool();
    const [rows] = await pool.execute("SELECT * FROM reports WHERE id = ?", [id]);
    if (!rows[0])
        return undefined;
    const [images] = await pool.execute(`SELECT ${IMAGE_COLUMNS} FROM report_images WHERE report_id = ? ORDER BY created_at`, [id]);
    return toReport(rows[0], images.map(toImage));
}
async function findReportsByAuthor(authorId) {
    const pool = getPool();
    const [rows] = await pool.execute("SELECT * FROM reports WHERE author_id = ? ORDER BY created_at DESC", [authorId]);
    if (rows.length === 0)
        return [];
    const [images] = await pool.query(`SELECT ${IMAGE_COLUMNS} FROM report_images WHERE report_id IN (?) ORDER BY created_at`, [rows.map((r) => r.id)]);
    const byReport = new Map();
    for (const img of images) {
        const list = byReport.get(img.report_id) ?? [];
        list.push(toImage(img));
        byReport.set(img.report_id, list);
    }
    return rows.map((r) => toReport(r, byReport.get(r.id) ?? []));
}
async function addReportImages(reportId, images) {
    const conn = await getPool().getConnection();
    const ids = images.map(() => randomUUID());
    try {
        await conn.beginTransaction();
        for (const [i, img] of images.entries()) {
            await conn.execute("INSERT INTO report_images (id, report_id, filename, mime_type, size, data) VALUES (?, ?, ?, ?, ?, ?)", [ids[i], reportId, img.filename, img.mimeType, img.size, img.data]);
        }
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
    const [rows] = await getPool().query(`SELECT ${IMAGE_COLUMNS} FROM report_images WHERE id IN (?) ORDER BY created_at`, [ids]);
    return rows.map(toImage);
}
async function findImageFile(imageId) {
    const [rows] = await getPool().execute(`SELECT i.report_id, i.mime_type, i.data, r.author_id
       FROM report_images i JOIN reports r ON r.id = i.report_id
      WHERE i.id = ?`, [imageId]);
    const row = rows[0];
    if (!row)
        return undefined;
    return { reportId: row.report_id, authorId: row.author_id, mimeType: row.mime_type, data: row.data };
}
// 개발용 시드 계정: users 테이블이 비어 있을 때만 생성
async function seedUsers() {
    const [rows] = await getPool().query("SELECT COUNT(*) AS n FROM users");
    if (rows[0]?.n > 0)
        return;
    await createUser("admin", "admin1234", "관리자", "admin");
    await createUser("user", "user1234", "사용자");
    console.log("시드 계정을 생성했습니다 (admin/admin1234, user/user1234)");
}
export { addReportImages, createReport, createUser, findImageFile, findReport, findReportsByAuthor, findUser, findUserByLoginId, seedUsers, verifyPassword, };
