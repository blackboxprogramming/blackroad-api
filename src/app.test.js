const request = require("supertest");

// Set test environment before importing app
process.env.NODE_ENV = "test";

const { app, closeDb } = require("./app");
const { getDb } = require("./db");
const authService = require("./services/auth.service");

describe("BlackRoad API v2", () => {
  let authToken;
  let adminToken;

  // Helper to setup auth
  const setupAuth = async () => {
    // Register users if they don't exist
    const db = getDb();
    const userExists = db.prepare("SELECT id FROM users WHERE username = ?").get("testuser");
    if (!userExists) {
      await authService.register("testuser", "TestPass123", "user");
    }
    const adminExists = db.prepare("SELECT id FROM users WHERE username = ?").get("adminuser");
    if (!adminExists) {
      await authService.register("adminuser", "AdminPass123", "admin");
    }

    // Get tokens
    const userLogin = await authService.login("testuser", "TestPass123");
    const adminLogin = await authService.login("adminuser", "AdminPass123");
    authToken = userLogin.data.token;
    adminToken = adminLogin.data.token;
  };

  beforeAll(async () => {
    await setupAuth();
  });

  beforeEach(async () => {
    // Only reset agents, not users
    const db = getDb();
    db.exec("DELETE FROM audit_log");
    db.exec("DELETE FROM agents");
    // Re-seed agents
    const insertAgent = db.prepare("INSERT INTO agents (id, role, active, metadata) VALUES (?, ?, ?, ?)");
    insertAgent.run("lucidia", "core", 1, "{}");
    insertAgent.run("roadie", "ops", 0, "{}");
  });

  afterAll(() => {
    closeDb();
  });

  describe("System Endpoints", () => {
    describe("GET /", () => {
      it("should return API info", async () => {
        const res = await request(app).get("/");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.name).toBe("BlackRoad API");
        expect(res.body.data.status).toBe("online");
        expect(res.body.data.docs).toBe("/docs");
      });

      it("should include request ID header", async () => {
        const res = await request(app).get("/");
        expect(res.headers["x-request-id"]).toBeDefined();
      });
    });

    describe("GET /health", () => {
      it("should return healthy status", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.data.healthy).toBe(true);
      });
    });

    describe("GET /status", () => {
      it("should return server status", async () => {
        const res = await request(app).get("/status");
        expect(res.status).toBe(200);
        expect(res.body.data.pid).toBeDefined();
        expect(res.body.data.memory).toBeDefined();
        expect(res.body.data.database).toBe("connected");
      });
    });

    describe("GET /metrics", () => {
      it("should return Prometheus metrics", async () => {
        const res = await request(app).get("/metrics");
        expect(res.status).toBe(200);
        expect(res.text).toContain("process_uptime_seconds");
      });

      it("should return JSON metrics when requested", async () => {
        const res = await request(app).get("/metrics?format=json");
        expect(res.status).toBe(200);
        expect(res.body.uptime_seconds).toBeDefined();
      });
    });

    describe("GET /routes", () => {
      it("should return list of routes", async () => {
        const res = await request(app).get("/routes");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data.length).toBeGreaterThan(0);
      });
    });

    describe("GET /openapi.json", () => {
      it("should return OpenAPI spec", async () => {
        const res = await request(app).get("/openapi.json");
        expect(res.status).toBe(200);
        expect(res.body.openapi).toBe("3.1.0");
        expect(res.body.info.title).toBe("BlackRoad API");
      });
    });
  });

  describe("Auth Endpoints", () => {
    describe("POST /api/v1/auth/register", () => {
      it("should register new user", async () => {
        const res = await request(app)
          .post("/api/v1/auth/register")
          .set("Content-Type", "application/json")
          .send({ username: "newuser", password: "NewPass123" });
        expect(res.status).toBe(201);
        expect(res.body.data.username).toBe("newuser");
      });

      it("should reject weak password", async () => {
        const res = await request(app)
          .post("/api/v1/auth/register")
          .set("Content-Type", "application/json")
          .send({ username: "weakuser", password: "weak" });
        expect(res.status).toBe(400);
      });
    });

    describe("POST /api/v1/auth/login", () => {
      it("should login and return token", async () => {
        const res = await request(app)
          .post("/api/v1/auth/login")
          .set("Content-Type", "application/json")
          .send({ username: "testuser", password: "TestPass123" });
        expect(res.status).toBe(200);
        expect(res.body.data.token).toBeDefined();
        expect(res.body.data.user.username).toBe("testuser");
      });

      it("should reject invalid credentials", async () => {
        const res = await request(app)
          .post("/api/v1/auth/login")
          .set("Content-Type", "application/json")
          .send({ username: "nonexistent", password: "WrongPass123" });
        expect(res.status).toBe(401);
      });
    });

    describe("GET /api/v1/auth/me", () => {
      it("should return current user profile", async () => {
        const res = await request(app)
          .get("/api/v1/auth/me")
          .set("Authorization", `Bearer ${authToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.username).toBe("testuser");
      });

      it("should reject unauthenticated request", async () => {
        const res = await request(app).get("/api/v1/auth/me");
        expect(res.status).toBe(401);
      });
    });
  });

  describe("Agents API (v1)", () => {
    describe("GET /api/v1/agents", () => {
      it("should return paginated list of agents", async () => {
        const res = await request(app).get("/api/v1/agents");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.meta.pagination).toBeDefined();
        expect(res.body.meta.pagination.page).toBe(1);
      });

      it("should filter by role", async () => {
        const res = await request(app).get("/api/v1/agents?role=core");
        expect(res.status).toBe(200);
        expect(res.body.data.every((a) => a.role === "core")).toBe(true);
      });

      it("should filter by active status", async () => {
        const res = await request(app).get("/api/v1/agents?active=true");
        expect(res.status).toBe(200);
        expect(res.body.data.every((a) => a.active === true)).toBe(true);
      });
    });

    describe("GET /api/v1/agents/:id", () => {
      it("should return agent by ID", async () => {
        const res = await request(app).get("/api/v1/agents/lucidia");
        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe("lucidia");
        expect(res.body.data.role).toBe("core");
      });

      it("should return 404 for non-existent agent", async () => {
        const res = await request(app).get("/api/v1/agents/nonexistent");
        expect(res.status).toBe(404);
      });
    });

    describe("POST /api/v1/agents", () => {
      it("should create new agent when authenticated", async () => {
        const res = await request(app)
          .post("/api/v1/agents")
          .set("Authorization", `Bearer ${authToken}`)
          .set("Content-Type", "application/json")
          .send({ id: "newagent", role: "test" });
        expect(res.status).toBe(201);
        expect(res.body.data.id).toBe("newagent");
      });

      it("should reject unauthenticated request", async () => {
        const res = await request(app)
          .post("/api/v1/agents")
          .set("Content-Type", "application/json")
          .send({ id: "unauth", role: "test" });
        expect(res.status).toBe(401);
      });

      it("should reject duplicate agent", async () => {
        const res = await request(app)
          .post("/api/v1/agents")
          .set("Authorization", `Bearer ${authToken}`)
          .set("Content-Type", "application/json")
          .send({ id: "lucidia", role: "test" });
        expect(res.status).toBe(409);
      });
    });

    describe("PUT /api/v1/agents/:id", () => {
      it("should update agent when authenticated", async () => {
        const res = await request(app)
          .put("/api/v1/agents/lucidia")
          .set("Authorization", `Bearer ${authToken}`)
          .set("Content-Type", "application/json")
          .send({ role: "updated" });
        expect(res.status).toBe(200);
        expect(res.body.data.role).toBe("updated");
      });

      it("should reject unauthenticated request", async () => {
        const res = await request(app)
          .put("/api/v1/agents/lucidia")
          .set("Content-Type", "application/json")
          .send({ role: "test" });
        expect(res.status).toBe(401);
      });
    });

    describe("DELETE /api/v1/agents/:id", () => {
      it("should delete agent when admin", async () => {
        const res = await request(app)
          .delete("/api/v1/agents/roadie")
          .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe("roadie");
      });

      it("should reject non-admin user", async () => {
        const res = await request(app)
          .delete("/api/v1/agents/lucidia")
          .set("Authorization", `Bearer ${authToken}`);
        expect(res.status).toBe(403);
      });

      it("should reject unauthenticated request", async () => {
        const res = await request(app).delete("/api/v1/agents/lucidia");
        expect(res.status).toBe(401);
      });
    });
  });

  describe("Echo Endpoint", () => {
    describe("POST /api/v1/echo", () => {
      it("should echo request body", async () => {
        const payload = { test: "data", num: 123 };
        const res = await request(app)
          .post("/api/v1/echo")
          .set("Content-Type", "application/json")
          .send(payload);
        expect(res.status).toBe(200);
        expect(res.body.data.you_sent).toEqual(payload);
      });
    });
  });

  describe("404 Handling", () => {
    it("should return 404 for unknown routes", async () => {
      const res = await request(app).get("/unknown/route");
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });

  describe("Request ID", () => {
    it("should use provided X-Request-Id header", async () => {
      const customId = "custom-request-id-123";
      const res = await request(app).get("/").set("X-Request-Id", customId);
      expect(res.headers["x-request-id"]).toBe(customId);
    });
  });

  describe("Legacy Route Redirect", () => {
    it("should redirect /api/agents to /api/v1/agents", async () => {
      const res = await request(app).get("/api/agents");
      expect(res.status).toBe(308);
      expect(res.headers.location).toBe("/api/v1/agents/");
    });
  });
});
