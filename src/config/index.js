const crypto = require("crypto");

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || "production",
  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",

  // API
  apiVersion: process.env.API_VERSION || "1.0.0",

  // Database
  dbPath: process.env.DB_PATH || "./data/blackroad.db",

  // JWT
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "24h",

  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 120,

  // CORS
  corsOrigins: process.env.CORS_ORIGINS || "*",

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",

  // Metrics
  metricsEnabled: process.env.METRICS_ENABLED !== "false",
};

// Validate critical config in production
if (config.isProduction) {
  if (config.jwtSecret.length < 32) {
    console.error("FATAL: JWT_SECRET must be at least 32 characters in production");
    process.exit(1);
  }
}

module.exports = config;
