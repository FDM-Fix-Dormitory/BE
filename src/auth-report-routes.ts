import { randomBytes } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { z } from 'zod';
import { ApiError, requireReadable, requireRole, statuses, type Actor, type Report } from './domain.js';
import { decodeCursor, idSchema, pageKey, pageResult, pageSchema } from './pagination.js';
import { parse } from './routes.js';
import { requireAuth } from './auth.js';
import {
  facilityTypes, hashToken, scopes, type AuthReportRepository, type NewImage, type StoredImage,
} from './auth-report-repository.js';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 5;

// 존재하지 않는 계정에도 같은 비용의 해시 비교를 수행해 계정 존재 여부가 응답 시간으로 드러나지 않게 합니다.
const dummyHash = bcrypt.hashSync(randomBytes(16).toString('hex'), 10);

const loginBody = z.object({
  loginId: z.string().min(1).max(50),
  password: z.string().min(1).max(200),
}).strict();

const text = (max: number) => z.string().trim().min(1).max(max);
const reportBody = z.object({
  scope: z.enum(scopes),
  title: text(200),
  location: text(255),
  roomNumber: z.string().regex(/^[1-9][0-9]{2}$/).nullable().optional(),
  facilityType: z.enum(facilityTypes),
  description: text(5000),
}).strict().superRefine((value, ctx) => {
  if (value.scope === 'ROOM' && !value.roomNumber) {
    ctx.addIssue({ code: 'custom', path: ['roomNumber'], message: 'ROOM 신고에는 호실이 필요합니다.' });
  }
  if (value.scope === 'COMMON' && value.roomNumber) {
    ctx.addIssue({ code: 'custom', path: ['roomNumber'], message: 'COMMON 신고에는 호실을 넣지 않습니다.' });
  }
});

const myReportsQuery = z.object({ ...pageSchema, status: z.enum(statuses).optional() }).strict();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_REQUEST, fields: 0 },
});

/** 클라이언트가 보낸 Content-Type이 아니라 파일 시그니처로 이미지 형식을 판별합니다. */
export function detectImageType(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

const imageDto = (image: StoredImage) => ({
  id: image.id, reportId: image.reportId, contentType: image.contentType, url: `/api/v1/report-images/${image.id}`,
});

const myReportCard = (report: Report) => ({
  id: report.id, scope: report.scope, title: report.title, location: report.location, roomNumber: report.roomNumber,
  facilityType: report.facilityType, status: report.status, sameIssueCount: Number(report.sameIssueCount),
  createdAt: report.createdAt.toISOString(),
});

const receiveImages: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'multipart/form-data로 보내 주세요.');
  }
  upload.array('images', MAX_IMAGES_PER_REQUEST)(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(413, 'PAYLOAD_TOO_LARGE', `이미지는 한 장당 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 이하여야 합니다.`));
      }
      return next(new ApiError(400, 'BAD_REQUEST', `images 필드로 이미지를 최대 ${MAX_IMAGES_PER_REQUEST}장까지 보내 주세요.`,
        [{ field: error.field ?? 'images', reason: error.code }]));
    }
    next(error);
  });
};

/** 김정현 담당 6개 API: 로그인·로그아웃·내 정보·신고 접수·내 신고·이미지 업로드(+이미지 조회). */
export function authReportRoutes(repository: AuthReportRepository) {
  const router = Router();
  const auth = requireAuth(repository);

  router.post('/auth/sessions', async (req, res) => {
    if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json으로 보내 주세요.');
    const { loginId, password } = parse(loginBody, req.body, 422);
    const user = await repository.findCredentials(loginId);
    const valid = await bcrypt.compare(password, user?.passwordHash ?? dummyHash);
    if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await repository.createSession(user.id, hashToken(token), expiresAt);
    res.status(201).json({ data: {
      token, tokenType: 'Bearer', expiresAt: expiresAt.toISOString(),
      user: { id: user.id, role: user.role, displayName: user.displayName },
    } });
  });

  const logout: RequestHandler = async (_req, res) => {
    await repository.revokeSession(res.locals.tokenHash);
    res.status(204).end();
  };
  // 협업 대화에서 변경된 경로(POST …/me/delete)와 업무 분담 문서의 경로(DELETE …/current)를 모두 지원합니다.
  router.post('/auth/sessions/me/delete', auth, logout);
  router.delete('/auth/sessions/current', auth, logout);

  router.get('/me', auth, async (_req, res) => {
    const actor: Actor = res.locals.actor;
    const user = await repository.findUser(actor.id);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    res.json({ data: { id: user.id, role: user.role, displayName: user.displayName } });
  });

  router.post('/reports', auth, async (req, res) => {
    const actor: Actor = res.locals.actor;
    requireRole(actor, 'STUDENT');
    if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json으로 보내 주세요.');
    const body = parse(reportBody, req.body, 422);
    const report = await repository.createReport(actor.id, { ...body, roomNumber: body.roomNumber ?? null });
    res.status(201).json({ data: {
      ...myReportCard(report), description: report.description, reporterId: report.reporterId,
      isConfirmedByMe: false, updatedAt: report.updatedAt.toISOString(), images: [],
    } });
  });

  router.get('/me/reports', auth, async (req, res) => {
    const actor: Actor = res.locals.actor;
    requireRole(actor, 'STUDENT');
    const query = parse(myReportsQuery, req.query);
    const key = pageKey({ endpoint: 'me/reports', userId: actor.id, status: query.status ?? null });
    const rows = await repository.listMyReports(actor.id, { ...query, cursor: decodeCursor(query.cursor, key) });
    const result = pageResult(rows, query.limit, key);
    res.json({ ...result, data: result.data.map(myReportCard) });
  });

  router.post('/reports/:reportId/images', auth, async (req, res, next) => {
    const actor: Actor = res.locals.actor;
    requireRole(actor, 'STUDENT');
    parse(z.object({}).strict(), req.query);
    const id = parse(idSchema, req.params.reportId);
    const report = await repository.findReportOwner(id);
    // 열람할 수 없는 신고는 존재하지 않는 신고와 같은 404, 열람만 가능한 남의 신고는 403입니다.
    requireReadable(report as Report | undefined, actor);
    if (report!.reporterId !== actor.id) throw new ApiError(403, 'FORBIDDEN', '본인 신고에만 사진을 올릴 수 있습니다.');
    res.locals.reportId = id;
    next();
  }, receiveImages, async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'images 필드로 이미지를 1장 이상 보내 주세요.', [{ field: 'images', reason: 'REQUIRED' }]);
    }
    const images: NewImage[] = [];
    for (const [index, file] of files.entries()) {
      const contentType = detectImageType(file.buffer);
      if (!contentType) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'JPEG, PNG, WEBP, GIF 이미지만 올릴 수 있습니다.',
          [{ field: `images.${index}`, reason: 'INVALID_IMAGE' }]);
      }
      images.push({ contentType, data: file.buffer });
    }
    const stored = await repository.addImages(res.locals.reportId, images);
    res.status(201).json({ data: stored.map(imageDto) });
  });

  // GET /reports/{reportId}의 images[].url이 가리키는 파일 조회. 신고 상세와 같은 열람 권한을 적용합니다.
  router.get('/report-images/:imageId', auth, async (req, res) => {
    const actor: Actor = res.locals.actor;
    const id = parse(idSchema, req.params.imageId);
    const image = await repository.findImage(id);
    if (!image) throw new ApiError(404, 'NOT_FOUND', '이미지를 찾을 수 없습니다.');
    try { requireReadable(image.report as Report, actor); }
    catch { throw new ApiError(404, 'NOT_FOUND', '이미지를 찾을 수 없습니다.'); }
    res.set({ 'Content-Type': image.contentType, 'Content-Length': String(image.data.length), 'Content-Disposition': 'inline' });
    res.end(image.data);
  });

  return router;
}
