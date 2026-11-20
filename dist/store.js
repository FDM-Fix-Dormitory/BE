import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
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
// ---------- 인메모리 저장소 (서버 재시작 시 초기화됨) ----------
const users = new Map();
const reports = new Map();
function createUser(loginId, password, displayName, role = "user") {
    const user = { id: randomUUID(), loginId, passwordHash: hashPassword(password), role, displayName };
    users.set(user.id, user);
    return user;
}
function findUser(id) {
    return users.get(id);
}
function findUserByLoginId(loginId) {
    for (const user of users.values())
        if (user.loginId === loginId)
            return user;
    return undefined;
}
function createReport(authorId, title, content) {
    const report = {
        id: randomUUID(),
        authorId,
        title,
        content,
        images: [],
        createdAt: new Date().toISOString(),
    };
    reports.set(report.id, report);
    return report;
}
function findReport(id) {
    return reports.get(id);
}
function findReportsByAuthor(authorId) {
    return [...reports.values()]
        .filter((r) => r.authorId === authorId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
// 개발용 시드 계정
createUser("admin", "admin1234", "관리자", "admin");
createUser("user", "user1234", "사용자");
export { createReport, createUser, findReport, findReportsByAuthor, findUser, findUserByLoginId, verifyPassword, };
