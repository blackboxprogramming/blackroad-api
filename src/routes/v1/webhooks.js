const express = require("express");
const webhookService = require("../../services/webhook.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Webhook validation schema
const WebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  events: z.array(z.string()).default(["*"]),
  headers: z.record(z.string()).optional(),
});

const WebhookUpdateSchema = WebhookSchema.partial().extend({
  active: z.boolean().optional(),
});

// Validation middleware
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

// List user's webhooks
router.get("/", authenticate, (req, res) => {
  try {
    const webhooks = webhookService.findByUser(req.user.id);
    // Don't expose secrets in list view
    send.ok(
      res,
      webhooks.map((w) => ({ ...w, secret: undefined }))
    );
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get single webhook
router.get("/:id", authenticate, (req, res) => {
  try {
    const webhook = webhookService.findById(parseInt(req.params.id));

    if (!webhook || webhook.userId !== req.user.id) {
      return send.notFound(res, "Webhook not found");
    }

    send.ok(res, webhook);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create webhook
router.post("/", authenticate, validate(WebhookSchema), (req, res) => {
  try {
    const webhook = webhookService.create(req.validated, req.user.id);

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "webhook",
      resourceId: webhook.id.toString(),
      newValue: { name: webhook.name, url: webhook.url, events: webhook.events },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, webhook);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Update webhook
router.put("/:id", authenticate, validate(WebhookUpdateSchema), (req, res) => {
  try {
    const webhook = webhookService.update(parseInt(req.params.id), req.validated, req.user.id);

    if (!webhook) {
      return send.notFound(res, "Webhook not found");
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "webhook",
      resourceId: req.params.id,
      newValue: req.validated,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, webhook);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete webhook
router.delete("/:id", authenticate, (req, res) => {
  try {
    const deleted = webhookService.delete(parseInt(req.params.id), req.user.id);

    if (!deleted) {
      return send.notFound(res, "Webhook not found");
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "webhook",
      resourceId: req.params.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, { deleted: true });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get webhook delivery history
router.get("/:id/deliveries", authenticate, (req, res) => {
  try {
    const webhook = webhookService.findById(parseInt(req.params.id));

    if (!webhook || webhook.userId !== req.user.id) {
      return send.notFound(res, "Webhook not found");
    }

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const result = webhookService.getDeliveries(parseInt(req.params.id), { page, limit });

    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Test webhook (send test payload)
router.post("/:id/test", authenticate, async (req, res) => {
  try {
    const webhook = webhookService.findById(parseInt(req.params.id));

    if (!webhook || webhook.userId !== req.user.id) {
      return send.notFound(res, "Webhook not found");
    }

    // Trigger a test event
    await webhookService.trigger("webhook.test", {
      webhookId: webhook.id,
      message: "This is a test webhook delivery",
      timestamp: new Date().toISOString(),
    });

    send.ok(res, { message: "Test webhook sent" });
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
