const express = require("express");
const dashboardService = require("../../services/dashboard.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");

const router = express.Router();

// Get overview statistics
router.get("/overview", authenticate, (req, res) => {
  try {
    const overview = dashboardService.getOverview();
    send.ok(res, overview);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get agent health summary
router.get("/agents/health", authenticate, (req, res) => {
  try {
    const health = dashboardService.getAgentHealth();
    send.ok(res, health);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get activity timeline
router.get("/activity/timeline", authenticate, (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    const interval = req.query.interval === "day" ? "day" : "hour";

    const timeline = dashboardService.getActivityTimeline({ hours, interval });
    send.ok(res, timeline);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get top actions/events
router.get("/activity/top", authenticate, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);

    const top = dashboardService.getTopActions({ limit, hours });
    send.ok(res, top);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get agent role distribution
router.get("/agents/roles", authenticate, (req, res) => {
  try {
    const roles = dashboardService.getAgentsByRole();
    send.ok(res, roles);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get recent activity feed
router.get("/activity/recent", authenticate, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const activity = dashboardService.getRecentActivity({ limit });
    send.ok(res, activity);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get system metrics
router.get("/system", authenticate, (req, res) => {
  try {
    const metrics = dashboardService.getSystemMetrics();
    send.ok(res, metrics);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
