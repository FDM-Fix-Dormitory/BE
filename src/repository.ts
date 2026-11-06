import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { ApiError, requireReadable, requireRole, type Actor, type Notification, type Report, type ReportImage, type Status } from './domain.js';
import type { Cursor, Sort } from './pagination.js';

export type ReportQuery = {
  scope?: 'COMMON' | 'ROOM'; status?: Status; sort: Sort; limit: number; cursor?: Cursor;
};
export type NotificationQuery = { limit: number; unreadOnly: boolean; cursor?: Cursor };
export interface ManagementRepository {
  findSession(token: string): Promise<Actor | undefined>;
  listReports(query: ReportQuery): Promise<Report[]>;
  findReport(id: string, actorId: string): Promise<Report | undefined>;
  images(reportId: string): Promise<ReportImage[]>;
  confirm(id: string, actor: Actor): Promise<{ created: boolean; count: number }>;
  changeStatus(id: string, status: Status, actor: Actor): Promise<{ id: string; status: Status; updatedAt: Date }>;
  notifications(actorId: string, query: NotificationQuery): Promise<Notification[]>;
}

const reportColumns = `r.id, r.scope, r.title, r.location, r.room_number AS roomNumber,
  r.facility_type AS facilityType, r.description, r.status, r.reporter_id AS reporterId,
  r.created_at AS createdAt, r.updated_at AS updatedAt`;
// Count from the unique confirmation rows, so no separate counter can drift.
const countSql = '(SELECT COUNT(*) FROM confirmations c WHERE c.report_id = r.id)';

export class MysqlManagementRepository implements ManagementRepository {
  constructor(private readonly db: Pool) {}

  async findSession(token: string): Promise<Actor | undefined> {
    const hash = createHash('sha256').update(token).digest('hex');
    const [rows] = await this.db.execute<(RowDataPacket & Actor)[]>(
      `SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND s.revoked_at IS NULL`, [hash],
    );
    const actor = rows[0];
    return actor && (actor.role === 'STUDENT' || actor.role === 'ADMIN') ? { id: actor.id, role: actor.role } : undefined;
  }

  async listReports(query: ReportQuery) {
    const where: string[] = [];
    const params: (string | number | Date)[] = [];
    if (query.scope) { where.push('r.scope = ?'); params.push(query.scope); }
    if (query.status) { where.push('r.status = ?'); params.push(query.status); }
    const asc = query.sort === 'createdAt_asc';
    const compare = asc ? '>' : '<';
    const c = query.cursor;
    if (c) {
      const time = new Date(c.createdAt);
      const tie = `(r.created_at ${compare} ? OR (r.created_at = ? AND r.id ${compare} ?))`;
      if (query.sort === 'sameIssueCount_desc') {
        where.push(`(${countSql} < ? OR (${countSql} = ? AND ${tie}))`);
        params.push(c.count, c.count, time, time, c.id);
      } else { where.push(tie); params.push(time, time, c.id); }
    }
    const order = query.sort === 'sameIssueCount_desc' ? 'sameIssueCount DESC, r.created_at DESC, r.id DESC'
      : `r.created_at ${asc ? 'ASC' : 'DESC'}, r.id ${asc ? 'ASC' : 'DESC'}`;
    params.push(query.limit + 1);
    // LIMIT is bound via query: MySQL prepared statements differ in numeric LIMIT handling across versions.
    const [rows] = await this.db.query<Report[]>(
      `SELECT ${reportColumns}, ${countSql} AS sameIssueCount, 0 AS isConfirmedByMe
       FROM reports r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`, params,
    );
    return rows;
  }

  async findReport(id: string, actorId: string) {
    const [rows] = await this.db.execute<Report[]>(
      `SELECT ${reportColumns}, ${countSql} AS sameIssueCount,
       EXISTS(SELECT 1 FROM confirmations c WHERE c.report_id = r.id AND c.user_id = ?) AS isConfirmedByMe
       FROM reports r WHERE r.id = ?`, [actorId, id],
    );
    return rows[0];
  }

  async images(reportId: string) {
    const [rows] = await this.db.execute<ReportImage[]>(
      'SELECT id, report_id AS reportId, content_type AS contentType FROM report_images WHERE report_id = ? ORDER BY created_at, id', [reportId],
    );
    return rows;
  }

  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (typeof error === 'object' && error !== null && 'code' in error &&
        (error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT')) {
        throw new ApiError(409, 'CONFLICT', '다른 요청과 충돌했습니다. 다시 시도해 주세요.');
      }
      throw error;
    } finally { connection.release(); }
  }

  async confirm(id: string, actor: Actor) {
    requireRole(actor, 'STUDENT');
    return this.transaction(async (connection) => {
      // Serialize confirmations and status changes for the same report.
      const [reports] = await connection.execute<Report[]>(`SELECT ${reportColumns} FROM reports r WHERE r.id = ? FOR UPDATE`, [id]);
      const report = reports[0];
      requireReadable(report, actor);
      if (report.scope !== 'COMMON') throw new ApiError(403, 'FORBIDDEN', '공용시설 신고에만 표시할 수 있습니다.');
      if (report.reporterId === actor.id) throw new ApiError(403, 'FORBIDDEN', '본인 신고에는 같은 문제를 표시할 수 없습니다.');
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT user_id FROM confirmations WHERE report_id = ? AND user_id = ?', [id, actor.id],
      );
      if (!existing.length) await connection.execute<ResultSetHeader>(
        'INSERT INTO confirmations (report_id, user_id) VALUES (?, ?)', [id, actor.id],
      );
      const [counts] = await connection.execute<(RowDataPacket & { count: number })[]>(
        'SELECT COUNT(*) AS count FROM confirmations WHERE report_id = ?', [id],
      );
      return { created: existing.length === 0, count: Number(counts[0]!.count) };
    });
  }

  async changeStatus(id: string, status: Status, actor: Actor) {
    requireRole(actor, 'ADMIN');
    return this.transaction(async (connection) => {
      const [reports] = await connection.execute<Report[]>(`SELECT ${reportColumns} FROM reports r WHERE r.id = ? FOR UPDATE`, [id]);
      const report = reports[0];
      requireReadable(report, actor);
      if (report.status === status) return { id, status, updatedAt: report.updatedAt };
      await connection.execute('UPDATE reports SET status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [status, id]);
      const [recipients] = await connection.execute<(RowDataPacket & { id: string })[]>(
        `SELECT id FROM users WHERE id = ? AND role = 'STUDENT'
         UNION SELECT u.id FROM confirmations c JOIN users u ON u.id = c.user_id WHERE c.report_id = ? AND u.role = 'STUDENT'`,
        [report.reporterId, id],
      );
      const eventId = randomUUID();
      for (const recipient of recipients) {
        await connection.execute(
          `INSERT INTO notifications (id, event_id, user_id, report_id, type, previous_status, new_status)
           VALUES (?, ?, ?, ?, 'REPORT_STATUS_CHANGED', ?, ?)`,
          [randomUUID(), eventId, recipient.id, id, report.status, status],
        );
      }
      const [updated] = await connection.execute<(RowDataPacket & { updatedAt: Date })[]>(
        'SELECT updated_at AS updatedAt FROM reports WHERE id = ?', [id],
      );
      return { id, status, updatedAt: updated[0]!.updatedAt };
    });
  }

  async notifications(actorId: string, query: NotificationQuery) {
    const where = ['n.user_id = ?', "u.role = 'STUDENT'", "(r.scope = 'COMMON' OR r.reporter_id = ?)"];
    const params: (string | number | Date)[] = [actorId, actorId];
    if (query.unreadOnly) where.push('n.read_at IS NULL');
    if (query.cursor) {
      where.push('(n.created_at < ? OR (n.created_at = ? AND n.id < ?))');
      params.push(new Date(query.cursor.createdAt), new Date(query.cursor.createdAt), query.cursor.id);
    }
    params.push(query.limit + 1);
    const [rows] = await this.db.query<Notification[]>(
      `SELECT n.id, n.report_id AS reportId, n.type, n.previous_status AS previousStatus,
       n.new_status AS newStatus, n.created_at AS createdAt, (n.read_at IS NOT NULL) AS \`read\`
       FROM notifications n JOIN reports r ON r.id = n.report_id JOIN users u ON u.id = n.user_id
       WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`, params,
    );
    return rows;
  }
}
