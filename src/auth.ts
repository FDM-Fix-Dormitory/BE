import type { NextFunction, Request, Response } from "express";

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).send({ error: "로그인이 필요합니다" });
  }
  next();
}

export { requireAuth };
