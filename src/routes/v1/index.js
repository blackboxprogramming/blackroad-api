const express = require("express");
const agentsRouter = require("./agents");
const authRouter = require("./auth");
const auditRouter = require("./audit");
const webhooksRouter = require("./webhooks");
const exportRouter = require("./export");

const router = express.Router();

// Mount v1 routes
router.use("/agents", agentsRouter);
router.use("/auth", authRouter);
router.use("/audit", auditRouter);
router.use("/webhooks", webhooksRouter);
router.use("/export", exportRouter);

// Echo endpoint (useful for testing)
router.post("/echo", (req, res) => {
  res.status(200).json({
    ok: true,
    status: 200,
    data: {
      you_sent: req.body || null,
      headers: {
        contentType: req.headers["content-type"],
        userAgent: req.headers["user-agent"],
      },
      requestId: req.id,
    },
  });
});

module.exports = router;
