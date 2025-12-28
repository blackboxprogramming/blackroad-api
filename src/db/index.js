const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const config = require("../config");

let db = null;

const initDatabase = () => {
  if (db) return db;

  // Ensure data directory exists
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Use in-memory DB for testing
  const dbPath = config.isTest ? ":memory:" : config.dbPath;
  db = new Database(dbPath);

  // Enable WAL mode for better performance
  if (!config.isTest) {
    db.pragma("journal_mode = WAL");
  }

  // Create tables
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Agents table
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id)
    );

    -- Audit log table
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      old_value TEXT,
      new_value TEXT,
      ip_address TEXT,
      request_id TEXT
    );

    -- API Keys table
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      permissions TEXT DEFAULT '[]',
      last_used_at TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
    CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(active);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
  `);

  // Seed default data if empty
  const agentCount = db.prepare("SELECT COUNT(*) as count FROM agents").get();
  if (agentCount.count === 0) {
    const insertAgent = db.prepare(`
      INSERT INTO agents (id, role, active, metadata) VALUES (?, ?, ?, ?)
    `);
    insertAgent.run("lucidia", "core", 1, "{}");
    insertAgent.run("roadie", "ops", 0, "{}");
  }

  return db;
};

const getDb = () => {
  if (!db) {
    return initDatabase();
  }
  return db;
};

const closeDb = () => {
  if (db) {
    db.close();
    db = null;
  }
};

// Reset database (for testing)
const resetDb = () => {
  if (db && config.isTest) {
    db.exec(`
      DELETE FROM audit_log;
      DELETE FROM api_keys;
      DELETE FROM agents;
      DELETE FROM users;
    `);
    // Re-seed
    const insertAgent = db.prepare(`
      INSERT INTO agents (id, role, active, metadata) VALUES (?, ?, ?, ?)
    `);
    insertAgent.run("lucidia", "core", 1, "{}");
    insertAgent.run("roadie", "ops", 0, "{}");
  }
};

module.exports = { initDatabase, getDb, closeDb, resetDb };
