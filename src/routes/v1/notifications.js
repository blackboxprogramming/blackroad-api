const express = require("express");
const notificationService = require("../../services/notification.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schemas
const SendNotificationSchema = z.object({
  type: z.string().min(1).max(50),
  title: z.string().min(1).max(200),
  message: z.string().max(1000).optional(),
  data: z.record(z.unknown()).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
  channels: z.array(z.string()).optional().default(["in_app"]),
});

const BroadcastSchema = SendNotificationSchema.extend({
  userIds: z.array(z.number()).optional(),
  role: z.string().optional(),
}).refine(
  (data) => data.userIds || data.role,
  { message: "Either userIds or role is required" }
);

const ChannelConfigSchema = z.object({
  channelType: z.enum(["webhook", "slack"]),
  config: z.record(z.unknown()),
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

// Get user's notifications
router.get("/", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const unreadOnly = req.query.unread === "true";

    const result = notificationService.getNotifications(req.user.id, { page, limit, unreadOnly });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get unread count
router.get("/unread-count", authenticate, (req, res) => {
  try {
    const count = notificationService.getUnreadCount(req.user.id);
    send.ok(res, { unreadCount: count });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Mark notification as read
router.patch("/:id/read", authenticate, (req, res) => {
  try {
    const result = notificationService.markAsRead(parseInt(req.params.id), req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Mark all as read
router.post("/read-all", authenticate, (req, res) => {
  try {
    const result = notificationService.markAllAsRead(req.user.id);
    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete notification
router.delete("/:id", authenticate, (req, res) => {
  try {
    const result = notificationService.delete(parseInt(req.params.id), req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Clear old notifications
router.delete("/", authenticate, (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.olderThanDays) || 30, 365);
    const result = notificationService.clearOld(req.user.id, days);
    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Admin: Send Notifications ====================

// Send notification to a user (admin only)
router.post("/send/:userId", authenticate, authorize("admin"), validate(SendNotificationSchema), async (req, res) => {
  try {
    const result = await notificationService.send(parseInt(req.params.userId), req.validated);
    send.created(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Broadcast notification (admin only)
router.post("/broadcast", authenticate, authorize("admin"), validate(BroadcastSchema), async (req, res) => {
  try {
    const result = await notificationService.broadcast(req.validated);
    send.created(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Channels ====================

// Get user's notification channels
router.get("/channels", authenticate, (req, res) => {
  try {
    const channels = notificationService.getUserChannels(req.user.id);
    send.ok(res, channels);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Add notification channel
router.post("/channels", authenticate, validate(ChannelConfigSchema), (req, res) => {
  try {
    const result = notificationService.addChannel(
      req.user.id,
      req.validated.channelType,
      req.validated.config
    );

    if (result.error) {
      return send.bad(res, result.message);
    }

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Verify channel
router.post("/channels/:id/verify", authenticate, (req, res) => {
  try {
    const result = notificationService.verifyChannel(parseInt(req.params.id), req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Remove channel
router.delete("/channels/:id", authenticate, (req, res) => {
  try {
    const result = notificationService.removeChannel(parseInt(req.params.id), req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Preferences ====================

// Get notification preferences
router.get("/preferences", authenticate, (req, res) => {
  try {
    const preferences = notificationService.getPreferences(req.user.id);
    send.ok(res, preferences);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Set notification preference
router.put("/preferences/:type/:channel", authenticate, (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return send.bad(res, "enabled must be a boolean");
    }

    const result = notificationService.setPreference(
      req.user.id,
      req.params.type,
      req.params.channel,
      enabled
    );

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
