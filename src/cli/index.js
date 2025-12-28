#!/usr/bin/env node
const { Command } = require("commander");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Initialize database before services
process.env.NODE_ENV = process.env.NODE_ENV || "production";
const { initDatabase, getDb, closeDb } = require("../db");
initDatabase();

const authService = require("../services/auth.service");
const agentService = require("../services/agent.service");
const exportService = require("../services/export.service");

const program = new Command();

program
  .name("blackroad")
  .description("BlackRoad API CLI")
  .version("2.1.0");

// ==================== Auth Commands ====================

const auth = program.command("auth").description("Authentication commands");

auth
  .command("create-user <username> <password>")
  .description("Create a new user")
  .option("-r, --role <role>", "User role (user/admin)", "user")
  .action(async (username, password, options) => {
    try {
      const result = await authService.register(username, password, options.role);
      if (result.error) {
        console.error("Error:", result.message);
        process.exit(1);
      }
      console.log("User created successfully:");
      console.log(`  ID: ${result.data.id}`);
      console.log(`  Username: ${result.data.username}`);
      console.log(`  Role: ${result.data.role}`);
    } finally {
      closeDb();
    }
  });

auth
  .command("create-api-key <username>")
  .description("Create an API key for a user")
  .option("-n, --name <name>", "Key name", "CLI Generated Key")
  .option("-e, --expires <duration>", "Expiration (e.g., 30d, 1y)")
  .action(async (username, options) => {
    try {
      const user = authService.findByUsername(username);
      if (!user) {
        console.error(`User "${username}" not found`);
        process.exit(1);
      }
      const result = await authService.generateApiKey(user.id, options.name, ["*"], options.expires);
      console.log("API Key created:");
      console.log(`  Key: ${result.key}`);
      console.log(`  Name: ${result.name}`);
      console.log(`  Expires: ${result.expiresAt || "Never"}`);
      console.log("\n⚠️  Save this key securely - it cannot be retrieved again!");
    } finally {
      closeDb();
    }
  });

auth
  .command("list-users")
  .description("List all users")
  .action(() => {
    try {
      const db = getDb();
      const users = db.prepare("SELECT id, username, role, created_at FROM users").all();
      console.log("Users:");
      console.table(users.map((u) => ({
        ID: u.id,
        Username: u.username,
        Role: u.role,
        Created: u.created_at,
      })));
    } finally {
      closeDb();
    }
  });

// ==================== Agent Commands ====================

const agents = program.command("agents").description("Agent management");

agents
  .command("list")
  .description("List all agents")
  .option("-r, --role <role>", "Filter by role")
  .option("-a, --active", "Only active agents")
  .option("--json", "Output as JSON")
  .action((options) => {
    try {
      const result = agentService.findAll({
        role: options.role,
        active: options.active,
        limit: 100,
      });

      if (options.json) {
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        console.log("Agents:");
        console.table(result.data.map((a) => ({
          ID: a.id,
          Role: a.role,
          Active: a.active ? "Yes" : "No",
          Created: a.createdAt,
        })));
      }
    } finally {
      closeDb();
    }
  });

agents
  .command("create <id> <role>")
  .description("Create a new agent")
  .option("-a, --active", "Set as active")
  .action((id, role, options) => {
    try {
      const result = agentService.create({ id, role, active: options.active || false });
      if (result.error) {
        console.error("Error:", result.message);
        process.exit(1);
      }
      console.log("Agent created:", result.data);
    } finally {
      closeDb();
    }
  });

agents
  .command("delete <id>")
  .description("Delete an agent")
  .action((id) => {
    try {
      const result = agentService.delete(id);
      if (result.error) {
        console.error("Error:", result.message);
        process.exit(1);
      }
      console.log(`Agent "${id}" deleted`);
    } finally {
      closeDb();
    }
  });

agents
  .command("get <id>")
  .description("Get agent details")
  .action((id) => {
    try {
      const agent = agentService.findById(id);
      if (!agent) {
        console.error(`Agent "${id}" not found`);
        process.exit(1);
      }
      console.log(JSON.stringify(agent, null, 2));
    } finally {
      closeDb();
    }
  });

// ==================== Export Commands ====================

const exp = program.command("export").description("Data export");

exp
  .command("agents")
  .description("Export agents")
  .option("-f, --format <format>", "Output format (json/csv)", "json")
  .option("-o, --output <file>", "Output file")
  .option("-r, --role <role>", "Filter by role")
  .action((options) => {
    try {
      let data;
      if (options.format === "csv") {
        data = exportService.exportAgentsCSV({ role: options.role });
      } else {
        data = JSON.stringify(exportService.exportAgentsJSON({ role: options.role }), null, 2);
      }

      if (options.output) {
        fs.writeFileSync(options.output, data);
        console.log(`Exported to ${options.output}`);
      } else {
        console.log(data);
      }
    } finally {
      closeDb();
    }
  });

exp
  .command("audit")
  .description("Export audit logs")
  .option("-f, --format <format>", "Output format (json/csv)", "json")
  .option("-o, --output <file>", "Output file")
  .option("-l, --limit <n>", "Max records", "1000")
  .action((options) => {
    try {
      let data;
      if (options.format === "csv") {
        data = exportService.exportAuditCSV({ limit: parseInt(options.limit) });
      } else {
        data = JSON.stringify(exportService.exportAuditJSON({ limit: parseInt(options.limit) }), null, 2);
      }

      if (options.output) {
        fs.writeFileSync(options.output, data);
        console.log(`Exported to ${options.output}`);
      } else {
        console.log(data);
      }
    } finally {
      closeDb();
    }
  });

exp
  .command("stats")
  .description("Show export statistics")
  .action(() => {
    try {
      const stats = exportService.getExportStats();
      console.log("Database Statistics:");
      console.table(stats);
    } finally {
      closeDb();
    }
  });

// ==================== Config Commands ====================

const config = program.command("config").description("Configuration");

config
  .command("init")
  .description("Initialize .env file with secure defaults")
  .option("-f, --force", "Overwrite existing .env")
  .action((options) => {
    const envPath = path.join(process.cwd(), ".env");

    if (fs.existsSync(envPath) && !options.force) {
      console.error(".env already exists. Use --force to overwrite.");
      process.exit(1);
    }

    const jwtSecret = crypto.randomBytes(32).toString("hex");

    const envContent = `# Server Configuration
PORT=4000
NODE_ENV=production

# API Configuration
API_VERSION=2.1.0

# Database
DB_PATH=./data/blackroad.db

# JWT Authentication
JWT_SECRET=${jwtSecret}
JWT_EXPIRES_IN=24h

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=120

# CORS
CORS_ORIGINS=*

# Logging
LOG_LEVEL=info

# Metrics
METRICS_ENABLED=true
`;

    fs.writeFileSync(envPath, envContent);
    console.log(".env file created with secure defaults");
    console.log(`JWT_SECRET: ${jwtSecret.slice(0, 10)}...`);
  });

config
  .command("generate-secret")
  .description("Generate a secure random secret")
  .option("-l, --length <n>", "Secret length in bytes", "32")
  .action((options) => {
    const secret = crypto.randomBytes(parseInt(options.length)).toString("hex");
    console.log(secret);
  });

// ==================== Database Commands ====================

const db = program.command("db").description("Database operations");

db
  .command("reset")
  .description("Reset database (WARNING: destroys all data)")
  .option("-y, --yes", "Skip confirmation")
  .action((options) => {
    if (!options.yes) {
      console.log("This will delete ALL data. Use --yes to confirm.");
      process.exit(1);
    }

    const dbPath = process.env.DB_PATH || "./data/blackroad.db";
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log("Database deleted:", dbPath);
    }

    // Reinitialize
    initDatabase();
    console.log("Database reinitialized");
    closeDb();
  });

db
  .command("stats")
  .description("Show database statistics")
  .action(() => {
    try {
      const database = getDb();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();

      console.log("Database Tables:");
      for (const table of tables) {
        const count = database.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
        console.log(`  ${table.name}: ${count.count} rows`);
      }
    } finally {
      closeDb();
    }
  });

// ==================== Server Info ====================

program
  .command("info")
  .description("Show system information")
  .action(() => {
    console.log("BlackRoad API");
    console.log("─".repeat(40));
    console.log(`Version: 2.1.0`);
    console.log(`Node.js: ${process.version}`);
    console.log(`Platform: ${process.platform}`);
    console.log(`Arch: ${process.arch}`);
    console.log(`PID: ${process.pid}`);
    console.log(`CWD: ${process.cwd()}`);
  });

// Parse arguments
program.parse();
