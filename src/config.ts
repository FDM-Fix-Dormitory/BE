import "dotenv/config";
import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);

export const config = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: port.default(3000),
    DB_HOST: z.string().min(1).default("127.0.0.1"),
    DB_PORT: port.default(3306),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_NAME: z.string().regex(/^[a-zA-Z0-9_]+$/),
  })
  .parse(process.env);
