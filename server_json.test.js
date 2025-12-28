const request = require("supertest");
const { app, AGENTS } = require("./server_json");

describe("BlackRoad API", () => {
  // Reset agents before each test
  beforeEach(() => {
    AGENTS.length = 0;
    AGENTS.push(
      { id: "lucidia", role: "core", active: true },
      { id: "roadie", role: "ops", active: false }
    );
  });

  describe("GET /", () => {
    it("should return API info", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.name).toBe("BlackRoad API");
      expect(res.body.data.status).toBe("online");
    });

    it("should include request ID header", async () => {
      const res = await request(app).get("/");
      expect(res.headers["x-request-id"]).toBeDefined();
    });
  });

  describe("GET /api/health", () => {
    it("should return healthy status", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.data.healthy).toBe(true);
    });
  });

  describe("GET /api/status", () => {
    it("should return server status", async () => {
      const res = await request(app).get("/api/status");
      expect(res.status).toBe(200);
      expect(res.body.data.pid).toBeDefined();
      expect(res.body.data.memory).toBeDefined();
      expect(res.body.data.uptime_seconds).toBeDefined();
    });
  });

  describe("GET /api/routes", () => {
    it("should return list of routes", async () => {
      const res = await request(app).get("/api/routes");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/agents", () => {
    it("should return list of agents", async () => {
      const res = await request(app).get("/api/agents");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
    });
  });

  describe("GET /api/agents/:id", () => {
    it("should return agent by ID", async () => {
      const res = await request(app).get("/api/agents/lucidia");
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("lucidia");
      expect(res.body.data.role).toBe("core");
    });

    it("should return 404 for non-existent agent", async () => {
      const res = await request(app).get("/api/agents/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });

  describe("POST /api/agents", () => {
    it("should create new agent", async () => {
      const res = await request(app)
        .post("/api/agents")
        .set("Content-Type", "application/json")
        .send({ id: "newagent", role: "test" });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("newagent");
    });

    it("should reject duplicate agent", async () => {
      const res = await request(app)
        .post("/api/agents")
        .set("Content-Type", "application/json")
        .send({ id: "lucidia", role: "test" });
      expect(res.status).toBe(409);
    });

    it("should reject missing fields", async () => {
      const res = await request(app)
        .post("/api/agents")
        .set("Content-Type", "application/json")
        .send({ id: "test" });
      expect(res.status).toBe(400);
      expect(res.body.error.details.errors).toBeDefined();
    });

    it("should reject non-JSON content type", async () => {
      const res = await request(app)
        .post("/api/agents")
        .set("Content-Type", "text/plain")
        .send("test");
      expect(res.status).toBe(415);
    });
  });

  describe("PUT /api/agents/:id", () => {
    it("should update agent", async () => {
      const res = await request(app)
        .put("/api/agents/lucidia")
        .set("Content-Type", "application/json")
        .send({ role: "updated" });
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe("updated");
    });

    it("should return 404 for non-existent agent", async () => {
      const res = await request(app)
        .put("/api/agents/nonexistent")
        .set("Content-Type", "application/json")
        .send({ role: "test" });
      expect(res.status).toBe(404);
    });

    it("should reject update with no fields", async () => {
      const res = await request(app)
        .put("/api/agents/lucidia")
        .set("Content-Type", "application/json")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/agents/:id", () => {
    it("should delete agent", async () => {
      const res = await request(app).delete("/api/agents/lucidia");
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe("lucidia");
      expect(AGENTS.find((a) => a.id === "lucidia")).toBeUndefined();
    });

    it("should return 404 for non-existent agent", async () => {
      const res = await request(app).delete("/api/agents/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/echo", () => {
    it("should echo request body", async () => {
      const payload = { test: "data", num: 123 };
      const res = await request(app)
        .post("/api/echo")
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.data.you_sent).toEqual(payload);
    });
  });

  describe("GET /api/openapi.json", () => {
    it("should return OpenAPI spec", async () => {
      const res = await request(app).get("/api/openapi.json");
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.1.0");
      expect(res.body.info.title).toBe("BlackRoad API");
    });
  });

  describe("404 handling", () => {
    it("should return 404 for unknown routes", async () => {
      const res = await request(app).get("/unknown/route");
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.details.path).toBe("/unknown/route");
    });
  });

  describe("Request ID", () => {
    it("should use provided X-Request-Id header", async () => {
      const customId = "custom-request-id-123";
      const res = await request(app)
        .get("/")
        .set("X-Request-Id", customId);
      expect(res.headers["x-request-id"]).toBe(customId);
    });
  });
});
