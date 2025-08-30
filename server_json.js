const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 4000;

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
  notFound: (res, path) =>
    res
      .status(404)
      .json({ ok: false, status: 404, error: { message: "Not Found", details: { path } } }),
  serverErr: (res, err) =>
    res.status(500).json({
      ok: false,
      status: 500,
      error: { message: "Internal Server Error", details: { reason: err?.message } },
    }),
};

// Trust proxy if behind Nginx
app.set("trust proxy", 1);

// Security / perf
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(compression());
app.use(morgan("combined"));

// Enforce JSON-only API
app.use((req, res, next) => {
  // Always respond JSON
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // For write methods, require JSON Content-Type
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

// Rate limit (e.g., 120 req/min per IP)
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
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

// Live route index (manually curated below)
const routes = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/status" },
  { method: "GET", path: "/api/routes" },
  { method: "GET", path: "/api/openapi.json" },
  { method: "POST", path: "/api/echo" },
  { method: "GET", path: "/api/agents" },
  { method: "POST", path: "/api/agents" },
];

app.get("/api/routes", (req, res) => send.ok(res, routes));

/** ---------------------------
 *  Example JSON resources
 *  --------------------------- */
// In-memory demo store
const AGENTS = [
  { id: "lucidia", role: "core", active: true },
  { id: "roadie", role: "ops", active: false },
];

app.get("/api/agents", (req, res) => send.ok(res, AGENTS));
app.post("/api/agents", (req, res) => {
  const { id, role, active = false } = req.body || {};
  if (!id || !role) return send.bad(res, "Missing required fields: id, role");
  if (AGENTS.find((a) => a.id === id)) return send.bad(res, "Agent already exists", { id }, 409);
  AGENTS.push({ id, role, active: !!active });
  return send.created(res, { id });
});

// Utility echo for testing clients
app.post("/api/echo", (req, res) => send.ok(res, { you_sent: req.body || null }));

/** ---------------------------
 *  OpenAPI (served as JSON)
 *  --------------------------- */
const openapi = {
  openapi: "3.1.0",
  info: { title: "BlackRoad API", version: "1.0.0" },
  servers: [{ url: "/" }],
  paths: {
    "/": { get: { summary: "API root", responses: { "200": { description: "OK" } } } },
    "/api/health": { get: { summary: "Health", responses: { "200": { description: "OK" } } } },
    "/api/status": { get: { summary: "Status", responses: { "200": { description: "OK" } } } },
    "/api/routes": { get: { summary: "List routes", responses: { "200": { description: "OK" } } } },
    "/api/agents": {
      get: { summary: "List agents", responses: { "200": { description: "OK" } } },
      post: {
        summary: "Create agent",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "Created" }, "409": { description: "Conflict" } },
      },
    },
    "/api/echo": {
      post: {
        summary: "Echo body",
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
app.use((req, res) => send.notFound(res, req.originalUrl));
app.use((err, req, res, _next) => {
  console.error("API error:", err);
  send.serverErr(res, err);
});

/** ---------------------------
 *  Start
 *  --------------------------- */
app.listen(PORT, () => {
  console.log(`[BlackRoad] JSON API listening on :${PORT}`);
});
