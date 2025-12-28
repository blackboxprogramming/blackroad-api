const { z } = require("zod");

// Agent schemas
const AgentSchema = z.object({
  id: z
    .string()
    .min(1, "id is required")
    .max(64, "id must be 64 characters or less")
    .regex(/^[a-zA-Z0-9_-]+$/, "id must be alphanumeric with underscores/hyphens"),
  role: z.string().min(1, "role is required").max(64, "role must be 64 characters or less"),
  active: z.boolean().optional().default(false),
  metadata: z.record(z.any()).optional().default({}),
});

const AgentUpdateSchema = z
  .object({
    role: z.string().min(1).max(64).optional(),
    active: z.boolean().optional(),
    metadata: z.record(z.any()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// Auth schemas
const LoginSchema = z.object({
  username: z.string().min(1, "username is required").max(64),
  password: z.string().min(8, "password must be at least 8 characters").max(128),
});

const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, "username must be at least 3 characters")
    .max(64)
    .regex(/^[a-zA-Z0-9_]+$/, "username must be alphanumeric with underscores"),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(128)
    .regex(/[A-Z]/, "password must contain at least one uppercase letter")
    .regex(/[a-z]/, "password must contain at least one lowercase letter")
    .regex(/[0-9]/, "password must contain at least one number"),
  role: z.enum(["user", "admin"]).optional().default("user"),
});

// Query schemas
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional().default("asc"),
});

const AgentQuerySchema = PaginationSchema.extend({
  role: z.string().optional(),
  active: z
    .string()
    .optional()
    .transform((val) => (val === "true" ? true : val === "false" ? false : undefined)),
  search: z.string().optional(),
});

// Validation helper
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res.status(400).json({
      ok: false,
      status: 400,
      error: { message: "Validation failed", details: { errors } },
    });
  }
  req.validated = result.data;
  next();
};

const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return res.status(400).json({
      ok: false,
      status: 400,
      error: { message: "Invalid query parameters", details: { errors } },
    });
  }
  req.query = result.data;
  next();
};

module.exports = {
  AgentSchema,
  AgentUpdateSchema,
  LoginSchema,
  RegisterSchema,
  PaginationSchema,
  AgentQuerySchema,
  validate,
  validateQuery,
};
