import mysql, { type Pool, type ResultSetHeader } from "mysql2/promise";

let pool: Pool | null = null;

export function getProjectPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: "127.0.0.1",
      port: 3306,
      user: "openclaw",
      password: "openclaw",
      database: "openclaw_projects",
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pool;
}

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const [rows] = await getProjectPool().execute(sql, params);
  return rows as T[];
}

export async function execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
  const [result] = await getProjectPool().execute(sql, params);
  return result as ResultSetHeader;
}

export async function closeProjectPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
