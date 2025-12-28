const express = require("express");
const templateService = require("../../services/template.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schema
const TemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.string().max(50).optional().default("agent"),
  default_metadata: z.record(z.unknown()).optional().default({}),
  config: z.record(z.unknown()).optional().default({}),
  tags: z.array(z.number()).optional().default([]),
  groups: z.array(z.number()).optional().default([]),
  is_default: z.boolean().optional().default(false),
});

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return send.bad(res, "Validation failed", {
      errors: result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  }
  req.validated = result.data;
  next();
};

// List all templates
router.get("/", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const { search } = req.query;

    const result = templateService.findAll({ page, limit, search });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get default template
router.get("/default", authenticate, (req, res) => {
  try {
    const template = templateService.getDefault();

    if (!template) {
      return send.notFound(res, "No default template configured");
    }

    send.ok(res, template);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get template by ID
router.get("/:id", authenticate, (req, res) => {
  try {
    const template = templateService.findById(parseInt(req.params.id));

    if (!template) {
      return send.notFound(res, "Template not found");
    }

    send.ok(res, template);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create a template
router.post("/", authenticate, validate(TemplateSchema), (req, res) => {
  try {
    const result = templateService.create(req.validated, req.user.id);

    if (result.error) {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "template",
      resourceId: result.data.id.toString(),
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Update a template
router.put("/:id", authenticate, (req, res) => {
  try {
    const result = templateService.update(parseInt(req.params.id), req.body, req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "template",
      resourceId: req.params.id,
      oldValue: result.oldValue,
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete a template
router.delete("/:id", authenticate, (req, res) => {
  try {
    const result = templateService.delete(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "template",
      resourceId: req.params.id,
      oldValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, { deleted: true });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Apply template (get merged configuration)
router.post("/:id/apply", authenticate, (req, res) => {
  try {
    const result = templateService.apply(parseInt(req.params.id), req.body, req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Clone a template
router.post("/:id/clone", authenticate, (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return send.bad(res, "name is required for clone");
    }

    const result = templateService.clone(parseInt(req.params.id), name, req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "clone",
      resourceType: "template",
      resourceId: req.params.id,
      newValue: { clonedId: result.data.id, name },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get template versions
router.get("/:id/versions", authenticate, (req, res) => {
  try {
    const template = templateService.findById(parseInt(req.params.id));

    if (!template) {
      return send.notFound(res, "Template not found");
    }

    const versions = templateService.getVersions(parseInt(req.params.id));
    send.ok(res, versions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Restore a specific version
router.post("/:id/versions/:version/restore", authenticate, (req, res) => {
  try {
    const result = templateService.restoreVersion(
      parseInt(req.params.id),
      parseInt(req.params.version),
      req.user.id
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "restore",
      resourceType: "template",
      resourceId: req.params.id,
      oldValue: result.oldValue,
      newValue: { restoredVersion: parseInt(req.params.version) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
