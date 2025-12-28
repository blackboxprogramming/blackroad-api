const pino = require("pino");
const config = require("../config");

// Create pino logger
const logger = pino({
  level: config.logLevel,
  transport: config.isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
  base: {
    env: config.nodeEnv,
  },
  redact: ["req.headers.authorization", "req.headers['x-api-key']", "password", "token"],
});

// Express middleware for request logging
const requestLogger = (req, res, next) => {
  const start = Date.now();

  // Log request
  req.log = logger.child({
    requestId: req.id,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    req.log[level]({
      status: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get("Content-Length"),
    });
  });

  next();
};

// Audit logger for mutations
const auditLogger = (action, resourceType) => {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      // Only log successful mutations
      if (body.ok && req.user) {
        logger.info({
          type: "audit",
          action,
          resourceType,
          resourceId: req.params.id || body.data?.id,
          userId: req.user.id,
          username: req.user.username,
          requestId: req.id,
          ip: req.ip,
        });
      }
      return originalJson(body);
    };

    next();
  };
};

module.exports = { logger, requestLogger, auditLogger };
