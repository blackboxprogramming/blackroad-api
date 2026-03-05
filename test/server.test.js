const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const app = require("../server_json.js");

let server;
let baseUrl;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

before((_, done) => {
  server = app.listen(0, () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

after((_, done) => {
  server.close(done);
});

describe("GET /", () => {
  it("returns API info", async () => {
    const res = await request("/");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.name, "BlackRoad API");
    assert.equal(res.body.data.status, "online");
  });
});

describe("GET /api/health", () => {
  it("returns healthy", async () => {
    const res = await request("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.healthy, true);
  });
});

describe("GET /api/status", () => {
  it("returns system status", async () => {
    const res = await request("/api/status");
    assert.equal(res.status, 200);
    assert.ok(res.body.data.pid);
    assert.ok(res.body.data.memory);
    assert.ok(typeof res.body.data.uptime_seconds === "number");
  });
});

describe("GET /api/routes", () => {
  it("returns route list", async () => {
    const res = await request("/api/routes");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 7);
  });
});

describe("GET /api/openapi.json", () => {
  it("returns OpenAPI spec", async () => {
    const res = await request("/api/openapi.json");
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, "3.1.0");
    assert.equal(res.body.info.title, "BlackRoad API");
  });
});

describe("GET /api/agents", () => {
  it("returns agents list", async () => {
    const res = await request("/api/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    const lucidia = res.body.data.find((a) => a.id === "lucidia");
    assert.ok(lucidia);
    assert.equal(lucidia.role, "core");
  });
});

describe("POST /api/agents", () => {
  it("creates a new agent", async () => {
    const res = await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { id: "test-agent", role: "test" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.id, "test-agent");
  });

  it("rejects duplicate agent", async () => {
    const res = await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { id: "lucidia", role: "core" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
  });

  it("rejects missing fields", async () => {
    const res = await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { id: "no-role" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  });

  it("rejects non-JSON content type", async () => {
    const res = await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: { id: "x", role: "y" },
    });
    assert.equal(res.status, 415);
  });
});

describe("POST /api/echo", () => {
  it("echoes request body", async () => {
    const payload = { message: "hello" };
    const res = await request("/api/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.you_sent, payload);
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await request("/api/nonexistent");
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });
});
