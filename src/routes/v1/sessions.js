const express = require("express");
const sessionService = require("../../services/session.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");

const router = express.Router();

// Get current user's sessions
router.get("/", authenticate, (req, res) => {
  try {
    const sessions = sessionService.getUserSessions(req.user.id);
    send.ok(res, sessions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get session stats (admin only)
router.get("/stats", authenticate, authorize("admin"), (req, res) => {
  try {
    const stats = sessionService.getStats();
    send.ok(res, stats);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Revoke a specific session
router.delete("/:id", authenticate, (req, res) => {
  try {
    const result = sessionService.revoke(req.params.id, req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "revoke_session",
      resourceType: "session",
      resourceId: req.params.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Revoke all other sessions
router.post("/revoke-all", authenticate, (req, res) => {
  try {
    // Get current session ID from token (would need to be passed or stored)
    const currentSessionId = req.headers["x-session-id"];

    const result = sessionService.revokeAllUserSessions(req.user.id, currentSessionId);

    auditService.log({
      userId: req.user.id,
      action: "revoke_all_sessions",
      resourceType: "session",
      newValue: { revokedCount: result.data.revokedCount },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Admin: Cleanup expired sessions
router.post("/cleanup", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = sessionService.cleanupExpired();
    send.ok(res, result);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Admin: Revoke all sessions for a user
router.delete("/user/:userId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = sessionService.revokeAllUserSessions(parseInt(req.params.userId));

    auditService.log({
      userId: req.user.id,
      action: "admin_revoke_user_sessions",
      resourceType: "session",
      resourceId: req.params.userId,
      newValue: { revokedCount: result.data.revokedCount },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
