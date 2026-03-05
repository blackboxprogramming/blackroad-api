/**
 * BlackRoad API — Cloudflare Worker
 *
 * Proprietary. Copyright (c) 2025 BlackRoad OS, Inc. All rights reserved.
 */

const AGENTS = [
  { id: "lucidia", role: "core", active: true },
  { id: "roadie", role: "ops", active: false },
];

const startedAt = new Date();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer-when-downgrade",
    },
  });
}

function ok(data = null, meta = {}) {
  return json({ ok: true, status: 200, data, meta });
}

function created(data = null, meta = {}) {
  return json({ ok: true, status: 201, data, meta }, 201);
}

function bad(message = "Bad Request", details = {}, status = 400) {
  return json({ ok: false, status, error: { message, details } }, status);
}

function notFound(path) {
  return json(
    { ok: false, status: 404, error: { message: "Not Found", details: { path } } },
    404
  );
}

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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/") {
      return ok({
        name: "BlackRoad API",
        version: "1.0.0",
        runtime: "cloudflare-workers",
        status: "online",
        uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        now: new Date().toISOString(),
      });
    }

    if (method === "GET" && path === "/api/health") {
      return ok({ healthy: true });
    }

    if (method === "GET" && path === "/api/status") {
      return ok({
        runtime: "cloudflare-workers",
        uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        env: { mode: "production" },
      });
    }

    if (method === "GET" && path === "/api/routes") {
      return ok(routes);
    }

    if (method === "GET" && path === "/api/openapi.json") {
      return json(openapi);
    }

    if (method === "GET" && path === "/api/agents") {
      return ok(AGENTS);
    }

    if (method === "POST" && path === "/api/agents") {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("application/json")) {
        return bad("Unsupported Media Type — use application/json", { expected: "application/json", got: ct || null }, 415);
      }
      const body = await request.json().catch(() => null);
      if (!body || !body.id || !body.role) {
        return bad("Missing required fields: id, role");
      }
      if (AGENTS.find((a) => a.id === body.id)) {
        return bad("Agent already exists", { id: body.id }, 409);
      }
      AGENTS.push({ id: body.id, role: body.role, active: !!body.active });
      return created({ id: body.id });
    }

    if (method === "POST" && path === "/api/echo") {
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("application/json")) {
        return bad("Unsupported Media Type — use application/json", { expected: "application/json", got: ct || null }, 415);
      }
      const body = await request.json().catch(() => null);
      return ok({ you_sent: body });
    }

    return notFound(path);
  },
};
