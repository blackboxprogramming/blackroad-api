const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const swaggerUi = require("swagger-ui-express");

const config = require("./config");
const { initDatabase, closeDb } = require("./db");
const { logger, requestLogger } = require("./middleware/logger");
const { metrics, metricsMiddleware } = require("./middleware/metrics");
const send = require("./utils/response");
const openapi = require("./openapi");
const v1Routes = require("./routes/v1");

// Services for table initialization
const webhookService = require("./services/webhook.service");
const totpService = require("./services/totp.service");
const agentControlService = require("./services/agent-control.service");
const websocketService = require("./services/websocket.service");
const groupService = require("./services/group.service");
const schedulerService = require("./services/scheduler.service");
const sessionService = require("./services/session.service");
const notificationService = require("./services/notification.service");
const permissionService = require("./services/permission.service");

// Initialize database
initDatabase();

// Initialize service tables (v2.1)
webhookService.initTable();
totpService.initTable();
agentControlService.initTable();

// Initialize service tables (v2.2)
groupService.initTable();
schedulerService.initTable();
sessionService.initTable();
notificationService.initTable();
permissionService.initTable();

const app = express();
const startedAt = new Date();

/** ---------------------------
 *  Request ID Middleware
 *  --------------------------- */
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// Trust proxy if behind Nginx
app.set("trust proxy", 1);

// Security
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// CORS
const corsOrigins = config.corsOrigins;
app.use(
  cors({
    origin: corsOrigins === "*" ? true : corsOrigins.split(","),
    credentials: true,
  })
);

// Performance
app.use(compression());

// Logging
app.use(requestLogger);

// Metrics
app.use(metricsMiddleware);

// JSON body parser
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const ct = (req.headers["content-type"] || "").toLowerCase();
    // Allow form data for docs
    if (req.path.startsWith("/docs")) return next();
    if (!ct.startsWith("application/json")) {
      return send.bad(
        res,
        "Unsupported Media Type — use application/json",
        { expected: "application/json", got: ct || null },
        415
      );
    }
  }
  next();
});

app.use(express.json({ limit: "2mb" }));

// Rate limiting
app.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, status: 429, error: { message: "Too Many Requests" } },
    skip: (req) => req.path === "/metrics" || req.path.startsWith("/docs"),
  })
);

/** ---------------------------
 *  System Routes
 *  --------------------------- */
app.get("/", (req, res) =>
  send.ok(res, {
    name: "BlackRoad API",
    version: config.apiVersion,
    status: "online",
    uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    now: new Date().toISOString(),
    docs: "/docs",
    api: "/api/v1",
  })
);

app.get("/health", (req, res) => send.ok(res, { healthy: true }));

app.get("/status", (req, res) =>
  send.ok(res, {
    pid: process.pid,
    memory: process.memoryUsage(),
    uptime_seconds: Math.floor(process.uptime()),
    env: { node: process.version, mode: config.nodeEnv },
    database: "connected",
    websocket: websocketService.getStats(),
  })
);

// Prometheus metrics endpoint
app.get("/metrics", (req, res) => {
  const format = req.query.format || "prometheus";
  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    return res.json(metrics.toJSON());
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(metrics.toPrometheus());
});

// Auto-discover routes
app.get("/routes", (req, res) => {
  const routes = [];
  const extractRoutes = (stack, prefix = "") => {
    stack.forEach((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .filter((m) => layer.route.methods[m])
          .map((m) => m.toUpperCase());
        methods.forEach((method) => {
          routes.push({ method, path: prefix + layer.route.path });
        });
      } else if (layer.name === "router" && layer.handle.stack) {
        const regexStr = layer.regexp.toString();
        const match = regexStr.match(/^\/\^\\(.*?)\\\//);
        const routePrefix = match ? match[1].replace(/\\/g, "") : "";
        extractRoutes(layer.handle.stack, prefix + routePrefix);
      }
    });
  };
  extractRoutes(app._router.stack);
  send.ok(res, routes.sort((a, b) => a.path.localeCompare(b.path)));
});

/** ---------------------------
 *  API Documentation (Swagger UI)
 *  --------------------------- */
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapi, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "BlackRoad API Docs",
  })
);

app.get("/openapi.json", (req, res) => res.json(openapi));

/** ---------------------------
 *  API v1 Routes
 *  --------------------------- */
app.use("/api/v1", v1Routes);

// Legacy routes redirect
app.use("/api/agents", (req, res) => {
  res.redirect(308, `/api/v1/agents${req.url}`);
});

/** ---------------------------
 *  404 + Error Handlers
 *  --------------------------- */
app.use((req, res) => send.notFound(res, "Not Found", { path: req.originalUrl }));

app.use((err, req, res, _next) => {
  logger.error({ err, requestId: req.id }, "Unhandled error");
  send.serverErr(res, err);
});

/** ---------------------------
 *  Graceful Shutdown
 *  --------------------------- */
let server = null;

const shutdown = (signal) => {
  logger.info({ signal }, "Shutting down gracefully...");

  // Stop background services
  schedulerService.stop();
  sessionService.stopCleanup();
  websocketService.close();

  if (server) {
    server.close((err) => {
      closeDb();
      if (err) {
        logger.error({ err }, "Error during shutdown");
        process.exit(1);
      }
      logger.info("Server closed successfully");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("Could not close connections in time, forcing shutdown");
      process.exit(1);
    }, 10000);
  } else {
    closeDb();
    process.exit(0);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/** ---------------------------
 *  Start Server
 *  --------------------------- */
const start = () => {
  server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "BlackRoad API started");
    logger.info({ docs: `http://localhost:${config.port}/docs` }, "API documentation available");

    // Initialize WebSocket server
    websocketService.init(server);
    logger.info({ path: "/ws" }, "WebSocket server initialized");

    // Start background services
    schedulerService.start();
    sessionService.startCleanup();
    logger.info("Background services started (scheduler, session cleanup)");
  });
  return server;
};

// Only start if this is the main module
if (require.main === module) {
  start();
}

module.exports = { app, start, closeDb };
