/**
 * Migration: Add webhooks and 2FA tables
 * Created: 2024-12-28
 */

module.exports = {
  up(db) {
    db.exec(`
      -- Webhooks
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        headers TEXT DEFAULT '{}',
        active INTEGER DEFAULT 1,
        user_id INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER REFERENCES webhooks(id),
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        attempts INTEGER DEFAULT 0,
        delivered_at TEXT,
        next_retry_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- 2FA
      CREATE TABLE IF NOT EXISTS user_totp (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        backup_codes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Agent commands and heartbeats
      CREATE TABLE IF NOT EXISTS agent_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        payload TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        result TEXT,
        issued_by INTEGER REFERENCES users(id),
        issued_at TEXT DEFAULT (datetime('now')),
        executed_at TEXT,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_heartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        metrics TEXT DEFAULT '{}',
        ip_address TEXT,
        version TEXT,
        received_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_agent_commands_agent ON agent_commands(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent ON agent_heartbeats(agent_id);
    `);
  },

  down(db) {
    db.exec(`
      DROP TABLE IF EXISTS agent_heartbeats;
      DROP TABLE IF EXISTS agent_commands;
      DROP TABLE IF EXISTS user_totp;
      DROP TABLE IF EXISTS webhook_deliveries;
      DROP TABLE IF EXISTS webhooks;
    `);
  },
};
