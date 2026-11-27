import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';

/** A separate mysqld process and new data directory; never connects to the user's MySQL service. */
export async function temporaryMysql() {
  const executable = process.env.MYSQLD_PATH ?? 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe';
  if (!existsSync(executable)) throw new Error('Set MYSQLD_PATH to a local MySQL 8.0.16+ mysqld executable.');
  const directory = await mkdtemp(join(tmpdir(), 'dom-mysql-test-'));
  const basedir = dirname(dirname(executable));
  const log: string[] = [];
  let server: ChildProcess | undefined;
  let pool: mysql.Pool | undefined;
  function launch(args: string[]) {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', chunk => { log.push(String(chunk)); });
    child.stderr?.on('data', chunk => { log.push(String(chunk)); });
    return child;
  }
  const cleanup = async () => {
    if (pool) {
      // SQL shutdown also stops MySQL's Windows supervisor/worker pair cleanly.
      try { await pool.query('SHUTDOWN'); }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error &&
          ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ECONNREFUSED'].includes(String(error.code)))) throw error;
      }
      await pool.end();
    }
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      if (!pool) server.kill();
      await exited;
    }
    // Validate the exact generated path before removing the test-only directory recursively.
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('dom-mysql-test-')) {
      throw new Error('Refusing cleanup outside the generated MySQL test directory.');
    }
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const init = launch(['--no-defaults', '--initialize-insecure', `--basedir=${basedir}`, `--datadir=${directory}`, '--console']);
    const [exitCode] = await once(init, 'exit');
    if (exitCode !== 0) throw new Error(`Temporary MySQL initialization failed:\n${log.join('')}`);
    const portFinder = net.createServer();
    portFinder.listen(0, '127.0.0.1');
    await once(portFinder, 'listening');
    const port = (portFinder.address() as net.AddressInfo).port;
    await new Promise<void>((resolveClose, reject) => portFinder.close(error => error ? reject(error) : resolveClose()));
    server = launch(['--no-defaults', `--basedir=${basedir}`, `--datadir=${directory}`, `--port=${port}`,
      '--bind-address=127.0.0.1', '--mysqlx=OFF', '--skip-log-bin', '--console',
      ...(process.platform === 'win32' ? ['--no-monitor'] : [])]);
    let connection: Connection | undefined;
    const deadline = Date.now() + 45_000;
    while (!connection && Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Temporary MySQL exited:\n${log.join('')}`);
      try { connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', connectTimeout: 500 }); }
      catch { await new Promise(resolveWait => setTimeout(resolveWait, 200)); }
    }
    if (!connection) throw new Error(`Temporary MySQL startup timed out:\n${log.join('')}`);
    const password = randomBytes(32).toString('hex');
    try {
      await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [password]);
      await connection.query('CREATE DATABASE dom_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    } finally { await connection.end(); }
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password, database: 'dom_test',
      timezone: 'Z', connectionLimit: 12, multipleStatements: false });
    const sql = await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await pool.query(statement);
    return { pool, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
