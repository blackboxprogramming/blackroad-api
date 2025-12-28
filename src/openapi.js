const config = require("./config");

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "BlackRoad API",
    version: config.apiVersion,
    description: "Production-grade JSON REST API with authentication, pagination, and audit logging",
    contact: {
      name: "BlackRoad Team",
    },
    license: {
      name: "MIT",
    },
  },
  servers: [
    { url: "/api/v1", description: "API v1" },
  ],
  tags: [
    { name: "Auth", description: "Authentication and authorization" },
    { name: "Agents", description: "Agent management" },
    { name: "Audit", description: "Audit logging" },
    { name: "System", description: "System endpoints" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
      },
    },
    schemas: {
      Agent: {
        type: "object",
        required: ["id", "role"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" },
          role: { type: "string", minLength: 1, maxLength: 64 },
          active: { type: "boolean", default: false },
          metadata: { type: "object", additionalProperties: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      AgentCreate: {
        type: "object",
        required: ["id", "role"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          role: { type: "string", minLength: 1, maxLength: 64 },
          active: { type: "boolean", default: false },
          metadata: { type: "object" },
        },
      },
      AgentUpdate: {
        type: "object",
        properties: {
          role: { type: "string", minLength: 1, maxLength: 64 },
          active: { type: "boolean" },
          metadata: { type: "object" },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "integer" },
          username: { type: "string" },
          role: { type: "string", enum: ["user", "admin"] },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", minLength: 1, maxLength: 64 },
          password: { type: "string", minLength: 8, maxLength: 128 },
        },
      },
      RegisterRequest: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string", minLength: 3, maxLength: 64 },
          password: { type: "string", minLength: 8, maxLength: 128 },
          role: { type: "string", enum: ["user", "admin"], default: "user" },
        },
      },
      TokenResponse: {
        type: "object",
        properties: {
          user: { $ref: "#/components/schemas/User" },
          token: { type: "string" },
          expiresIn: { type: "string" },
        },
      },
      SuccessResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          status: { type: "integer" },
          data: { type: "object" },
          meta: { type: "object" },
        },
      },
      PaginatedResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          status: { type: "integer" },
          data: { type: "array", items: {} },
          meta: {
            type: "object",
            properties: {
              pagination: {
                type: "object",
                properties: {
                  page: { type: "integer" },
                  limit: { type: "integer" },
                  total: { type: "integer" },
                  totalPages: { type: "integer" },
                  hasNext: { type: "boolean" },
                  hasPrev: { type: "boolean" },
                },
              },
            },
          },
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
    parameters: {
      pageParam: {
        name: "page",
        in: "query",
        schema: { type: "integer", minimum: 1, default: 1 },
      },
      limitParam: {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      sortParam: {
        name: "sort",
        in: "query",
        schema: { type: "string" },
      },
      orderParam: {
        name: "order",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"], default: "asc" },
      },
    },
  },
  paths: {
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register new user",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } },
        },
        responses: {
          "201": { description: "User created" },
          "400": { description: "Validation error" },
          "409": { description: "Username taken" },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login and get JWT token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
        },
        responses: {
          "200": {
            description: "Login successful",
            content: { "application/json": { schema: { $ref: "#/components/schemas/TokenResponse" } } },
          },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get current user profile",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        responses: {
          "200": { description: "User profile" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/auth/api-keys": {
      post: {
        tags: ["Auth"],
        summary: "Generate API key",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  permissions: { type: "array", items: { type: "string" } },
                  expiresIn: { type: "string", example: "30d" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "API key created" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/agents": {
      get: {
        tags: ["Agents"],
        summary: "List all agents",
        parameters: [
          { $ref: "#/components/parameters/pageParam" },
          { $ref: "#/components/parameters/limitParam" },
          { $ref: "#/components/parameters/sortParam" },
          { $ref: "#/components/parameters/orderParam" },
          { name: "role", in: "query", schema: { type: "string" } },
          { name: "active", in: "query", schema: { type: "boolean" } },
          { name: "search", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Paginated list of agents",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PaginatedResponse" } } },
          },
        },
      },
      post: {
        tags: ["Agents"],
        summary: "Create new agent",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AgentCreate" } } },
        },
        responses: {
          "201": { description: "Agent created" },
          "400": { description: "Validation error" },
          "401": { description: "Unauthorized" },
          "409": { description: "Agent already exists" },
        },
      },
    },
    "/agents/{id}": {
      get: {
        tags: ["Agents"],
        summary: "Get agent by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Agent details" },
          "404": { description: "Agent not found" },
        },
      },
      put: {
        tags: ["Agents"],
        summary: "Update agent",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/AgentUpdate" } } },
        },
        responses: {
          "200": { description: "Agent updated" },
          "400": { description: "Validation error" },
          "401": { description: "Unauthorized" },
          "404": { description: "Agent not found" },
        },
      },
      delete: {
        tags: ["Agents"],
        summary: "Delete agent (admin only)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Agent deleted" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden (admin required)" },
          "404": { description: "Agent not found" },
        },
      },
    },
    "/audit": {
      get: {
        tags: ["Audit"],
        summary: "Get audit logs (admin only)",
        security: [{ bearerAuth: [] }, { apiKey: [] }],
        parameters: [
          { $ref: "#/components/parameters/pageParam" },
          { $ref: "#/components/parameters/limitParam" },
          { name: "userId", in: "query", schema: { type: "integer" } },
          { name: "action", in: "query", schema: { type: "string" } },
          { name: "resourceType", in: "query", schema: { type: "string" } },
          { name: "startDate", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "endDate", in: "query", schema: { type: "string", format: "date-time" } },
        ],
        responses: {
          "200": { description: "Paginated audit logs" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden" },
        },
      },
    },
  },
};

module.exports = openapi;
