import type { RowDataPacket } from "mysql2";

export const statuses = [
  "RECEIVED",
  "REVIEWING",
  "REPAIRING",
  "COMPLETED",
] as const;
export type Status = (typeof statuses)[number];
export type Actor = { id: string; role: "STUDENT" | "ADMIN" };
export interface Report extends RowDataPacket {
  id: string;
  scope: "COMMON" | "ROOM";
  title: string;
  location: string;
  roomNumber: string | null;
  facilityType: string;
  description: string;
  status: Status;
  reporterId: string;
  sameIssueCount: number;
  isConfirmedByMe: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface Notification extends RowDataPacket {
  id: string;
  reportId: string;
  type: "REPORT_STATUS_CHANGED";
  previousStatus: Status;
  newStatus: Status;
  createdAt: Date;
  read: number;
}
export interface ReportImage extends RowDataPacket {
  id: string;
  reportId: string;
  contentType: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { field: string; reason: string }[],
  ) {
    super(message);
  }
}

export function requireReadable(
  report: Report | undefined,
  actor: Actor,
): asserts report is Report {
  if (
    !report ||
    (report.scope === "ROOM" &&
      actor.role !== "ADMIN" &&
      report.reporterId !== actor.id)
  ) {
    throw new ApiError(404, "NOT_FOUND", "신고를 찾을 수 없습니다.");
  }
}

export function requireRole(actor: Actor, role: Actor["role"]) {
  if (actor.role !== role)
    throw new ApiError(403, "FORBIDDEN", "이 작업을 수행할 권한이 없습니다.");
}

export function publicCard(report: Report) {
  return {
    id: report.id,
    scope: report.scope,
    title: report.title,
    location: report.location,
    facilityType: report.facilityType,
    status: report.status,
    sameIssueCount: Number(report.sameIssueCount),
    createdAt: report.createdAt.toISOString(),
  };
}

export function adminCard(report: Report) {
  return {
    id: report.id,
    scope: report.scope,
    roomNumber: report.roomNumber,
    location: report.location,
    facilityType: report.facilityType,
    status: report.status,
    sameIssueCount: Number(report.sameIssueCount),
    createdAt: report.createdAt.toISOString(),
  };
}
