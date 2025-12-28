const { getDb } = require("../db");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class BackupService {
  constructor() {
    this.backupDir = process.env.BACKUP_DIR || "./backups";
  }

  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        filename TEXT UNIQUE NOT NULL,
        size_bytes INTEGER,
        checksum TEXT,
        type TEXT DEFAULT 'full', -- 'full', 'incremental', 'schema'
        status TEXT DEFAULT 'completed', -- 'pending', 'in_progress', 'completed', 'failed'
        tables_included TEXT DEFAULT '[]',
        row_counts TEXT DEFAULT '{}',
        error_message TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS backup_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT DEFAULT 'full',
        frequency TEXT NOT NULL, -- 'hourly', 'daily', 'weekly', 'monthly'
        retention_days INTEGER DEFAULT 30,
        enabled INTEGER DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        config TEXT DEFAULT '{}',
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at);
      CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status);
    `);

    // Ensure backup directory exists
    this._ensureBackupDir();
  }

  _ensureBackupDir() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  // Create a backup
  create(options = {}, userId) {
    const db = getDb();
    const { name, type = "full", tables } = options;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = name || `backup-${type}-${timestamp}`;
    const filename = `${backupName}.sqlite3`;
    const backupPath = path.join(this.backupDir, filename);

    // Create backup record
    const result = db.prepare(`
      INSERT INTO backups (name, filename, type, status, created_by)
      VALUES (?, ?, ?, 'in_progress', ?)
    `).run(backupName, filename, type, userId);

    const backupId = result.lastInsertRowid;

    try {
      // Perform backup
      const backupDb = db.backup(backupPath);

      // Wait for backup to complete
      while (!backupDb.completed) {
        backupDb.step(100);
      }

      // Get file stats
      const stats = fs.statSync(backupPath);
      const checksum = this._calculateChecksum(backupPath);

      // Get table row counts
      const rowCounts = this._getRowCounts(db, tables);
      const tablesIncluded = tables || this._getAllTables(db);

      // Update backup record
      db.prepare(`
        UPDATE backups
        SET status = 'completed', size_bytes = ?, checksum = ?,
            tables_included = ?, row_counts = ?
        WHERE id = ?
      `).run(
        stats.size,
        checksum,
        JSON.stringify(tablesIncluded),
        JSON.stringify(rowCounts),
        backupId
      );

      return { data: this.findById(backupId) };
    } catch (err) {
      db.prepare(`
        UPDATE backups
        SET status = 'failed', error_message = ?
        WHERE id = ?
      `).run(err.message, backupId);

      return { error: "BACKUP_FAILED", message: err.message };
    }
  }

  // Find backup by ID
  findById(id) {
    const db = getDb();
    const backup = db.prepare(`
      SELECT b.*, u.username as created_by_username
      FROM backups b
      LEFT JOIN users u ON b.created_by = u.id
      WHERE b.id = ?
    `).get(id);

    return backup ? this._formatBackup(backup) : null;
  }

  // Find all backups
  findAll({ page = 1, limit = 50, type, status } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (type) {
      conditions.push("b.type = ?");
      params.push(type);
    }
    if (status) {
      conditions.push("b.status = ?");
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM backups b ${where}`).get(...params).count;

    const backups = db.prepare(`
      SELECT b.*, u.username as created_by_username
      FROM backups b
      LEFT JOIN users u ON b.created_by = u.id
      ${where}
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: backups.map(this._formatBackup),
      pagination: { page, limit, total },
    };
  }

  // Restore from backup
  restore(backupId, options = {}) {
    const db = getDb();
    const backup = this.findById(backupId);

    if (!backup) {
      return { error: "NOT_FOUND", message: "Backup not found" };
    }

    if (backup.status !== "completed") {
      return { error: "INVALID_STATE", message: "Cannot restore incomplete backup" };
    }

    const backupPath = path.join(this.backupDir, backup.filename);

    if (!fs.existsSync(backupPath)) {
      return { error: "FILE_NOT_FOUND", message: "Backup file not found" };
    }

    // Verify checksum
    const currentChecksum = this._calculateChecksum(backupPath);
    if (currentChecksum !== backup.checksum) {
      return { error: "CHECKSUM_MISMATCH", message: "Backup file corrupted" };
    }

    const { tables, dryRun = false } = options;

    if (dryRun) {
      return {
        data: {
          backupId,
          dryRun: true,
          wouldRestore: backup.tablesIncluded,
          rowCounts: backup.rowCounts,
        },
      };
    }

    try {
      // Close current db and restore
      // Note: In production, this would be more sophisticated
      const Database = require("better-sqlite3");
      const backupDb = new Database(backupPath, { readonly: true });

      const tablesToRestore = tables || backup.tablesIncluded;
      const restoredCounts = {};

      for (const table of tablesToRestore) {
        // Skip system tables
        if (table.startsWith("sqlite_") || table === "backups" || table === "backup_schedules") {
          continue;
        }

        try {
          // Get data from backup
          const rows = backupDb.prepare(`SELECT * FROM ${table}`).all();

          // Clear existing data
          db.prepare(`DELETE FROM ${table}`).run();

          // Insert backup data
          if (rows.length > 0) {
            const columns = Object.keys(rows[0]);
            const placeholders = columns.map(() => "?").join(", ");
            const insertStmt = db.prepare(
              `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
            );

            const insertMany = db.transaction((items) => {
              for (const item of items) {
                insertStmt.run(...columns.map((col) => item[col]));
              }
            });

            insertMany(rows);
          }

          restoredCounts[table] = rows.length;
        } catch (tableErr) {
          restoredCounts[table] = { error: tableErr.message };
        }
      }

      backupDb.close();

      return {
        data: {
          backupId,
          restored: true,
          restoredTables: Object.keys(restoredCounts).filter(
            (t) => typeof restoredCounts[t] === "number"
          ),
          rowCounts: restoredCounts,
        },
      };
    } catch (err) {
      return { error: "RESTORE_FAILED", message: err.message };
    }
  }

  // Delete a backup
  delete(id) {
    const db = getDb();
    const backup = this.findById(id);

    if (!backup) {
      return { error: "NOT_FOUND", message: "Backup not found" };
    }

    // Delete file
    const backupPath = path.join(this.backupDir, backup.filename);
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }

    // Delete record
    db.prepare("DELETE FROM backups WHERE id = ?").run(id);

    return { data: backup };
  }

  // Download backup (returns file path)
  getDownloadPath(id) {
    const backup = this.findById(id);

    if (!backup) {
      return { error: "NOT_FOUND", message: "Backup not found" };
    }

    const backupPath = path.join(this.backupDir, backup.filename);

    if (!fs.existsSync(backupPath)) {
      return { error: "FILE_NOT_FOUND", message: "Backup file not found" };
    }

    return { data: { path: backupPath, filename: backup.filename, size: backup.sizeBytes } };
  }

  // Export specific tables to JSON
  exportToJson(tables, options = {}) {
    const db = getDb();
    const { pretty = false } = options;
    const result = {};

    const tablesToExport = tables || this._getAllTables(db);

    for (const table of tablesToExport) {
      try {
        result[table] = db.prepare(`SELECT * FROM ${table}`).all();
      } catch {
        result[table] = { error: "Failed to export" };
      }
    }

    const json = pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result);

    return { data: { tables: Object.keys(result), json, size: json.length } };
  }

  // Import from JSON
  importFromJson(jsonData, options = {}) {
    const db = getDb();
    const { tables, mode = "merge" } = options; // mode: 'merge', 'replace', 'append'

    let data;
    try {
      data = typeof jsonData === "string" ? JSON.parse(jsonData) : jsonData;
    } catch {
      return { error: "INVALID_JSON", message: "Invalid JSON data" };
    }

    const tablesToImport = tables || Object.keys(data);
    const importedCounts = {};

    for (const table of tablesToImport) {
      if (!data[table] || !Array.isArray(data[table])) {
        continue;
      }

      try {
        const rows = data[table];

        if (mode === "replace") {
          db.prepare(`DELETE FROM ${table}`).run();
        }

        if (rows.length > 0) {
          const columns = Object.keys(rows[0]);
          const placeholders = columns.map(() => "?").join(", ");

          const conflictClause = mode === "merge" ? "OR REPLACE" : "OR IGNORE";
          const insertStmt = db.prepare(
            `INSERT ${conflictClause} INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
          );

          const insertMany = db.transaction((items) => {
            for (const item of items) {
              insertStmt.run(...columns.map((col) => item[col]));
            }
          });

          insertMany(rows);
        }

        importedCounts[table] = rows.length;
      } catch (tableErr) {
        importedCounts[table] = { error: tableErr.message };
      }
    }

    return {
      data: {
        imported: true,
        mode,
        tables: Object.keys(importedCounts).filter((t) => typeof importedCounts[t] === "number"),
        rowCounts: importedCounts,
      },
    };
  }

  // Cleanup old backups
  cleanup(retentionDays = 30) {
    const db = getDb();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const oldBackups = db.prepare(`
      SELECT * FROM backups
      WHERE created_at < ? AND (expires_at IS NULL OR expires_at < datetime('now'))
    `).all(cutoffDate.toISOString());

    let deletedCount = 0;
    let freedBytes = 0;

    for (const backup of oldBackups) {
      const backupPath = path.join(this.backupDir, backup.filename);
      if (fs.existsSync(backupPath)) {
        freedBytes += backup.size_bytes || 0;
        fs.unlinkSync(backupPath);
      }
      db.prepare("DELETE FROM backups WHERE id = ?").run(backup.id);
      deletedCount++;
    }

    return {
      data: {
        deletedCount,
        freedBytes,
        freedMB: Math.round(freedBytes / 1024 / 1024 * 100) / 100,
      },
    };
  }

  // Get backup stats
  getStats() {
    const db = getDb();

    const totalBackups = db.prepare("SELECT COUNT(*) as count FROM backups").get().count;
    const completedBackups = db.prepare("SELECT COUNT(*) as count FROM backups WHERE status = 'completed'").get().count;
    const totalSize = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) as size FROM backups WHERE status = 'completed'").get().size;

    const latestBackup = db.prepare(`
      SELECT * FROM backups
      WHERE status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();

    const backupsByType = db.prepare(`
      SELECT type, COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as size
      FROM backups
      WHERE status = 'completed'
      GROUP BY type
    `).all().reduce((acc, row) => {
      acc[row.type] = { count: row.count, sizeBytes: row.size };
      return acc;
    }, {});

    return {
      totalBackups,
      completedBackups,
      totalSizeBytes: totalSize,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      latestBackup: latestBackup ? this._formatBackup(latestBackup) : null,
      byType: backupsByType,
      backupDirectory: this.backupDir,
    };
  }

  _calculateChecksum(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256");
    hash.update(fileBuffer);
    return hash.digest("hex");
  }

  _getAllTables(db) {
    return db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => row.name);
  }

  _getRowCounts(db, tables) {
    const allTables = tables || this._getAllTables(db);
    const counts = {};

    for (const table of allTables) {
      try {
        counts[table] = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
      } catch {
        counts[table] = 0;
      }
    }

    return counts;
  }

  _formatBackup(row) {
    return {
      id: row.id,
      name: row.name,
      filename: row.filename,
      sizeBytes: row.size_bytes,
      sizeMB: row.size_bytes ? Math.round(row.size_bytes / 1024 / 1024 * 100) / 100 : null,
      checksum: row.checksum,
      type: row.type,
      status: row.status,
      tablesIncluded: JSON.parse(row.tables_included || "[]"),
      rowCounts: JSON.parse(row.row_counts || "{}"),
      errorMessage: row.error_message,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
}

module.exports = new BackupService();
