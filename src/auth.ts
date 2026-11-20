import type { Request, RequestHandler } from "express";
import { ApiError, type Actor } from "./domain.js";
import {
  hashToken,
  type AuthReportRepository,
} from "./auth-report-repository.js";
import type { SessionResolver } from "./routes.js";

const bearerPattern = /^Bearer ([A-Za-z0-9._~-]{16,512})$/i;

export function bearerToken(req: Request): string | undefined {
  return bearerPattern.exec(req.get("Authorization") ?? "")?.[1];
}

/** 세션 토큰을 DB에서 검증해 사용자를 찾습니다. 관리 API(`managementRoutes`)에도 같은 resolver를 연결합니다. */
export function sessionResolver(
  repository: Pick<AuthReportRepository, "findSession">,
): SessionResolver {
  return async (req) => {
    const token = bearerToken(req);
    return token ? repository.findSession(hashToken(token)) : undefined;
  };
}

/** 인증 미들웨어: `res.locals.actor`와 현재 세션의 `res.locals.tokenHash`를 설정합니다. */
export function requireAuth(
  repository: Pick<AuthReportRepository, "findSession">,
): RequestHandler {
  return async (req, res, next) => {
    res.vary("Authorization");
    const token = bearerToken(req);
    const tokenHash = token ? hashToken(token) : undefined;
    const actor: Actor | undefined = tokenHash
      ? await repository.findSession(tokenHash)
      : undefined;
    if (!actor) throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
    res.locals.actor = actor;
    res.locals.tokenHash = tokenHash;
    next();
  };
}
