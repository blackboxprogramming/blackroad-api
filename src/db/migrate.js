#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { initDatabase, getDb, closeDb } = require("./index");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Initialize database and migrations table
const init = () => {
  initDatabase();
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      executed_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
};

// Get list of migration files
const getMigrationFiles = () => {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    return [];
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();
};

// Get executed migrations
const getExecutedMigrations = (db) => {
  return db
    .prepare("SELECT name FROM migrations ORDER BY id")
    .all()
    .map((m) => m.name);
};

// Run pending migrations
const migrate = () => {
  const db = init();
  const files = getMigrationFiles();
  const executed = getExecutedMigrations(db);

  const pending = files.filter((f) => !executed.includes(f));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    closeDb();
    return;
  }

  console.log(`Running ${pending.length} migration(s)...`);

  for (const file of pending) {
    const migration = require(path.join(MIGRATIONS_DIR, file));

    console.log(`  Running: ${file}`);

    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO migrations (name) VALUES (?)").run(file);
      })();
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.error(`  ✗ ${file}: ${err.message}`);
      closeDb();
      process.exit(1);
    }
  }

  console.log("Migrations complete.");
  closeDb();
};

// Rollback last migration
const rollback = (count = 1) => {
  const db = init();
  const executed = getExecutedMigrations(db);

  if (executed.length === 0) {
    console.log("No migrations to rollback.");
    closeDb();
    return;
  }

  const toRollback = executed.slice(-count).reverse();

  console.log(`Rolling back ${toRollback.length} migration(s)...`);

  for (const name of toRollback) {
    const migration = require(path.join(MIGRATIONS_DIR, name));

    if (!migration.down) {
      console.error(`  ✗ ${name}: No down() function defined`);
      continue;
    }

    console.log(`  Rolling back: ${name}`);

    try {
      db.transaction(() => {
        migration.down(db);
        db.prepare("DELETE FROM migrations WHERE name = ?").run(name);
      })();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
      closeDb();
      process.exit(1);
    }
  }

  console.log("Rollback complete.");
  closeDb();
};

// Show migration status
const status = () => {
  const db = init();
  const files = getMigrationFiles();
  const executed = getExecutedMigrations(db);

  console.log("Migration Status:");
  console.log("─".repeat(50));

  if (files.length === 0) {
    console.log("No migrations found.");
  } else {
    for (const file of files) {
      const isExecuted = executed.includes(file);
      const status = isExecuted ? "✓" : "○";
      console.log(`  ${status} ${file}`);
    }
  }

  console.log("─".repeat(50));
  console.log(`Total: ${files.length}, Executed: ${executed.length}, Pending: ${files.length - executed.length}`);
  closeDb();
};

// Create new migration file
const create = (name) => {
  if (!name) {
    console.error("Please provide a migration name");
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const filename = `${timestamp}_${name.toLowerCase().replace(/\s+/g, "_")}.js`;
  const filepath = path.join(MIGRATIONS_DIR, filename);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  }

  const template = `/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */

module.exports = {
  up(db) {
    // Write your migration here
    db.exec(\`
      -- Your SQL here
    \`);
  },

  down(db) {
    // Write your rollback here
    db.exec(\`
      -- Your rollback SQL here
    \`);
  },
};
`;

  fs.writeFileSync(filepath, template);
  console.log(`Created migration: ${filepath}`);
};

// CLI
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case "up":
  case "migrate":
    migrate();
    break;
  case "down":
  case "rollback":
    rollback(parseInt(arg) || 1);
    break;
  case "status":
    status();
    break;
  case "create":
    create(arg);
    break;
  default:
    console.log(`
Database Migration Tool

Usage:
  node migrate.js <command> [args]

Commands:
  migrate, up     Run pending migrations
  rollback, down  Rollback last migration (optionally specify count)
  status          Show migration status
  create <name>   Create new migration file

Examples:
  node migrate.js migrate
  node migrate.js rollback 2
  node migrate.js create "add user preferences"
`);
}
