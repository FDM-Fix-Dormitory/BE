import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './domain.js';

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const pageSchema = {
  limit: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().max(100)).default(20),
  cursor: z.string().min(1).max(2048).optional(),
};
export const sortSchema = z.enum(['createdAt_desc', 'createdAt_asc', 'sameIssueCount_desc']);
export type Sort = z.infer<typeof sortSchema>;
const cursorSchema = z.object({
  v: z.literal(1), key: z.string(), id: idSchema,
  createdAt: z.iso.datetime().refine(value => Number(value.slice(0, 4)) >= 1000), count: z.number().int().nonnegative(),
}).strict();
export type Cursor = z.infer<typeof cursorSchema>;

export function pageKey(filters: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}

export function decodeCursor(encoded: string | undefined, key: string): Cursor | undefined {
  if (!encoded) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (decoded.key !== key) throw new Error();
    return decoded;
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', '올바른 목록 커서를 보내 주세요.');
  }
}

export function pageResult<T extends { id: string; createdAt: Date }>(rows: T[], limit: number, key: string, count: (row: T) => number = () => 0) {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    v: 1, key, id: last.id, createdAt: last.createdAt.toISOString(), count: Number(count(last)),
  })).toString('base64url') : null;
  return { data, page: { nextCursor, hasMore } };
}
