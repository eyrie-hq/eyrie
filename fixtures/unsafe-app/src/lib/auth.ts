import type { NextFunction, Request, Response } from 'express';

/** Minimal auth guard for the fixture. */
export function requireAuth() {
  return (_req: Request, _res: Response, next: NextFunction) => next();
}
