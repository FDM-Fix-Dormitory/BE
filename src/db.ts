import mysql from "mysql2/promise";
import { config } from "./config.js";

export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 100,
  charset: "utf8mb4",
  timezone: "Z",
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
});
