const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { z } = require("zod");

const app = express();
const PORT = process.env.PORT || 4000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** ---------------------------
 *  Helpers: JSON envelope
 *  --------------------------- */
const send = {
  ok: (res, data = null, meta = {}) =>
    res.status(200).json({ ok: true, status: 200, data, meta }),
  created: (res, data = null, meta = {}) =>
    res.status(201).json({ ok: true, status: 201, data, meta }),
  bad: (res, message = "Bad Request", details = {}, status = 400) =>
    res.status(status).json({ ok: false, status, error: { message, details } }),
  notFound: (res, message = "Not Found", details = {}) =>
    res.status(404).json({ ok: false, status: 404, error: { message, details } }),
  serverErr: (res, err) => {
    const message = "Internal Server Error";
    const details = IS_PRODUCTION ? {} : { reason: err?.message };
    res.status(500).json({ ok: false, status: 500, error: { message, details } });
  },
};

/** ---------------------------
 *  Validation Schemas (Zod)
 *  --------------------------- */
const AgentSchema = z.object({
  id: z.string().min(1, "id is required").max(64, "id must be 64 characters or less"),
  role: z.string().min(1, "role is required").max(64, "role must be 64 characters or less"),
  active: z.boolean().optional().default(false),
});

const AgentUpdateSchema = z.object({
  role: z.string().min(1).max(64).optional(),
  active: z.boolean().optional(),
}).refine(data => data.role !== undefined || data.active !== undefined, {
  message: "At least one field (role or active) must be provided",
});

/** ---------------------------
 *  Request ID Middleware
 *  --------------------------- */
const requestIdMiddleware = (req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
};

// Custom morgan token for request ID
morgan.token("request-id", (req) => req.id || "-");

// Trust proxy if behind Nginx
app.set("trust proxy", 1);

// Request ID (must be before morgan for logging)
app.use(requestIdMiddleware);

// Security / perf
app.use(helmet({ contentSecurityPolicy: false }));

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS;
const corsOptions = {
  origin: corsOrigins === "*" ? true : corsOrigins ? corsOrigins.split(",") : true,
  credentials: true,
};
app.use(cors(corsOptions));

app.use(compression());
app.use(morgan(":method :url :status :response-time ms - :request-id"));

// Enforce JSON-only API
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const ct = (req.headers["content-type"] || "").toLowerCase();
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

// Rate limit
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 120;
app.use(
  rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, status: 429, error: { message: "Too Many Requests" } },
  })
);

/** ---------------------------
 *  Basic meta routes
 *  --------------------------- */
const startedAt = new Date();

app.get("/", (req, res) =>
  send.ok(res, {
    name: "BlackRoad API",
    version: process.env.API_VERSION || "1.0.0",
    status: "online",
    uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    now: new Date().toISOString(),
  })
);

app.get("/api/health", (req, res) => send.ok(res, { healthy: true }));

app.get("/api/status", (req, res) =>
  send.ok(res, {
    pid: process.pid,
    memory: process.memoryUsage(),
    uptime_seconds: Math.floor(process.uptime()),
    env: { node: process.version, mode: process.env.NODE_ENV || "production" },
  })
);

/** ---------------------------
 *  Auto-discover routes
 *  --------------------------- */
const getRoutes = (expressApp) => {
  const routes = [];
  expressApp._router.stack.forEach((middleware) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods)
        .filter((m) => middleware.route.methods[m])
        .map((m) => m.toUpperCase());
      methods.forEach((method) => {
        routes.push({ method, path: middleware.route.path });
      });
    }
  });
  return routes.sort((a, b) => a.path.localeCompare(b.path));
};

app.get("/api/routes", (req, res) => send.ok(res, getRoutes(app)));

/** ---------------------------
 *  Agents CRUD API
 *  --------------------------- */
const AGENTS = [
  { id: "lucidia", role: "core", active: true },
  { id: "roadie", role: "ops", active: false },
];

// List all agents
app.get("/api/agents", (req, res) => send.ok(res, AGENTS));

// Get single agent by ID
app.get("/api/agents/:id", (req, res) => {
  const agent = AGENTS.find((a) => a.id === req.params.id);
  if (!agent) {
    return send.notFound(res, "Agent not found", { id: req.params.id });
  }
  send.ok(res, agent);
});

// Create new agent
app.post("/api/agents", (req, res) => {
  const result = AgentSchema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.errors.map((e) => ({ field: e.path.join("."), message: e.message }));
    return send.bad(res, "Validation failed", { errors });
  }

  const { id, role, active } = result.data;
  if (AGENTS.find((a) => a.id === id)) {
    return send.bad(res, "Agent already exists", { id }, 409);
  }

  AGENTS.push({ id, role, active });
  return send.created(res, { id, role, active });
});

// Update agent
app.put("/api/agents/:id", (req, res) => {
  const agentIndex = AGENTS.findIndex((a) => a.id === req.params.id);
  if (agentIndex === -1) {
    return send.notFound(res, "Agent not found", { id: req.params.id });
  }

  const result = AgentUpdateSchema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.errors.map((e) => ({ field: e.path.join("."), message: e.message }));
    return send.bad(res, "Validation failed", { errors });
  }

  const updates = result.data;
  AGENTS[agentIndex] = { ...AGENTS[agentIndex], ...updates };
  send.ok(res, AGENTS[agentIndex]);
});

// Delete agent
app.delete("/api/agents/:id", (req, res) => {
  const agentIndex = AGENTS.findIndex((a) => a.id === req.params.id);
  if (agentIndex === -1) {
    return send.notFound(res, "Agent not found", { id: req.params.id });
  }

  const [deleted] = AGENTS.splice(agentIndex, 1);
  send.ok(res, { deleted: deleted.id });
});

// Utility echo for testing clients
app.post("/api/echo", (req, res) => send.ok(res, { you_sent: req.body || null }));

/** ---------------------------
 *  OpenAPI (served as JSON)
 *  --------------------------- */
const openapi = {
  openapi: "3.1.0",
  info: { title: "BlackRoad API", version: "1.0.0", description: "Lightweight JSON REST API" },
  servers: [{ url: "/" }],
  components: {
    schemas: {
      Agent: {
        type: "object",
        required: ["id", "role"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64, description: "Unique agent identifier" },
          role: { type: "string", minLength: 1, maxLength: 64, description: "Agent role" },
          active: { type: "boolean", default: false, description: "Whether agent is active" },
        },
      },
      AgentUpdate: {
        type: "object",
        properties: {
          role: { type: "string", minLength: 1, maxLength: 64 },
          active: { type: "boolean" },
        },
      },
      SuccessResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          status: { type: "integer", example: 200 },
          data: { type: "object" },
          meta: { type: "object" },
        },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: false },
          status: { type: "integer" },
          error: {
            type: "object",
            properties: {
              message: { type: "string" },
              details: { type: "object" },
            },
          },
        },
      },
    },
  },
  paths: {
    "/": {
      get: {
        summary: "API root",
        description: "Returns API info and health status",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/health": {
      get: { summary: "Health check", responses: { "200": { description: "OK" } } },
    },
    "/api/status": {
      get: { summary: "Server status", responses: { "200": { description: "OK" } } },
    },
    "/api/routes": {
      get: { summary: "List all routes", responses: { "200": { description: "OK" } } },
    },
    "/api/agents": {
      get: {
        summary: "List all agents",
        responses: { "200": { description: "List of agents" } },
      },
      post: {
        summary: "Create agent",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Agent" } } },
        },
        responses: {
          "201": { description: "Created" },
          "400": { description: "Validation error" },
          "409": { description: "Agent already exists" },
        },
      },
    },
    "/api/agents/{id}": {
      get: {
        summary: "Get agent by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Agent details" },
          "404": { description: "Agent not found" },
        },
      },
      put: {
        summary: "Update agent",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AgentUpdate" } } },
        },
        responses: {
          "200": { description: "Updated agent" },
          "400": { description: "Validation error" },
          "404": { description: "Agent not found" },
        },
      },
      delete: {
        summary: "Delete agent",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Agent deleted" },
          "404": { description: "Agent not found" },
        },
      },
    },
    "/api/echo": {
      post: {
        summary: "Echo request body",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "OK" }, "415": { description: "Unsupported Media Type" } },
      },
    },
  },
};

app.get("/api/openapi.json", (req, res) => res.status(200).json(openapi));

/** ---------------------------
 *  404 + error JSON handlers
 *  --------------------------- */
app.use((req, res) => send.notFound(res, "Not Found", { path: req.originalUrl }));

app.use((err, req, res, _next) => {
  console.error(`[${req.id || "-"}] API error:`, err);
  send.serverErr(res, err);
});

/** ---------------------------
 *  Graceful Shutdown
 *  --------------------------- */
let server = null;

const shutdown = (signal) => {
  console.log(`\n[BlackRoad] Received ${signal}, shutting down gracefully...`);
  if (server) {
    server.close((err) => {
      if (err) {
        console.error("[BlackRoad] Error during shutdown:", err);
        process.exit(1);
      }
      console.log("[BlackRoad] Server closed successfully");
      process.exit(0);
    });

    // Force close after 10s
    setTimeout(() => {
      console.error("[BlackRoad] Could not close connections in time, forcefully shutting down");
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/** ---------------------------
 *  Start
 *  --------------------------- */
server = app.listen(PORT, () => {
  console.log(`[BlackRoad] JSON API listening on :${PORT}`);
  console.log(`[BlackRoad] Environment: ${process.env.NODE_ENV || "production"}`);
});

// Export for testing
module.exports = { app, AGENTS };
