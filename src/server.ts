import { createApp } from './app.js';
import { MysqlManagementRepository } from './repository.js';
import { MysqlAuthReportRepository } from './auth-report-repository.js';
import { sessionResolver } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';

async function main() {
  await pool.query('SELECT 1');
  const authReportRepository = new MysqlAuthReportRepository(pool);
  const app = createApp(
    new MysqlManagementRepository(pool), sessionResolver(authReportRepository),
    entry => console.info(JSON.stringify(entry)), authReportRepository,
  );
  const server = app.listen(config.PORT, () => {
    console.log(`D.O.M API listening on port ${config.PORT}`);
  });
  server.on('error', (error) => {
    console.error('HTTP server failed:', error);
    void pool.end().finally(() => { process.exitCode = 1; });
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    server.close(() => {
      void pool.end().then(() => { clearTimeout(timeout); }).catch((error: unknown) => {
        console.error('Database shutdown failed:', error);
        process.exitCode = 1;
      });
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error: unknown) => {
  console.error('Startup failed. Check MySQL and environment configuration:', error);
  await pool.end();
  process.exitCode = 1;
});
