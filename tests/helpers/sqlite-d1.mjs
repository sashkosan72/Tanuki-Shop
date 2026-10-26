import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Small D1-shaped adapter for application-logic tests only.
 * SQLite runs entirely in memory. This is not a workerd/D1 emulator and it
 * intentionally uses the local fixture, not a presumed production schema.
 */
export class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(readFileSync(new URL("../../dev/schema.sql", import.meta.url), "utf8"));
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

class PreparedStatement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new PreparedStatement(this.database, this.sql, parameters);
  }

  async first(column) {
    const row = this.database.sqlite.prepare(this.sql).get(...this.parameters);
    if (!row) return null;
    return column === undefined ? { ...row } : row[column];
  }

  async all() {
    const rows = this.database.sqlite.prepare(this.sql).all(...this.parameters);
    return { success: true, results: rows.map(row => ({ ...row })) };
  }

  execute() {
    const result = this.database.sqlite.prepare(this.sql).run(...this.parameters);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }

  async run() {
    return this.execute();
  }
}
