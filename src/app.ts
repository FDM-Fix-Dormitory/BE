import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { ApiError } from './domain.js';
import { managementRoutes, type SessionResolver } from './routes.js';
import type { ManagementRepository } from './repository.js';

export type RequestLog = {
  requestId: string; method: string; route: string; status: number;
  authentication: 'authenticated' | 'unauthenticated';
};

export function createApp(
  repository: ManagementRepository,
  resolver?: SessionResolver,
  logger?: (entry: RequestLog) => void,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.on('finish', () => logger?.({
      requestId: res.locals.requestId,
      method: req.method,
      // Log templates, never report IDs, query strings, tokens or request bodies.
      route: typeof req.route?.path === 'string' ? req.route.path : 'unmatched',
      status: res.statusCode,
      authentication: res.locals.actor ? 'authenticated' : 'unauthenticated',
    }));
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', managementRoutes(repository, resolver));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', '요청한 API를 찾을 수 없습니다.')));

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    let failure: ApiError;
    if (error instanceof ApiError) {
      failure = error;
    } else {
      const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
      failure = status === 413 ? new ApiError(413, 'PAYLOAD_TOO_LARGE', '요청 크기가 너무 큽니다.')
        : status === 400 ? new ApiError(400, 'BAD_REQUEST', '올바른 JSON을 보내 주세요.')
          : new ApiError(500, 'INTERNAL_ERROR', '서버 오류가 발생했습니다.');
      if (failure.status === 500) console.error({ requestId: res.locals.requestId, code: failure.code });
    }
    res.status(failure.status).json({ error: {
      code: failure.code, message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
    } });
  };
  app.use(handleError);
  return app;
}
