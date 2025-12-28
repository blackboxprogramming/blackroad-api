const express = require("express");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");

const router = express.Router();

// Get audit logs (admin only)
router.get("/", authenticate, authorize("admin"), (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      userId,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
    } = req.query;

    const result = auditService.findAll({
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      userId: userId ? parseInt(userId) : undefined,
      action,
      resourceType,
      resourceId,
      startDate,
      endDate,
    });

    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
