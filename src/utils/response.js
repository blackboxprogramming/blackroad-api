const config = require("../config");

const send = {
  ok: (res, data = null, meta = {}) =>
    res.status(200).json({ ok: true, status: 200, data, meta }),

  created: (res, data = null, meta = {}) =>
    res.status(201).json({ ok: true, status: 201, data, meta }),

  noContent: (res) => res.status(204).end(),

  bad: (res, message = "Bad Request", details = {}, status = 400) =>
    res.status(status).json({ ok: false, status, error: { message, details } }),

  unauthorized: (res, message = "Unauthorized", details = {}) =>
    res.status(401).json({ ok: false, status: 401, error: { message, details } }),

  forbidden: (res, message = "Forbidden", details = {}) =>
    res.status(403).json({ ok: false, status: 403, error: { message, details } }),

  notFound: (res, message = "Not Found", details = {}) =>
    res.status(404).json({ ok: false, status: 404, error: { message, details } }),

  conflict: (res, message = "Conflict", details = {}) =>
    res.status(409).json({ ok: false, status: 409, error: { message, details } }),

  tooMany: (res, message = "Too Many Requests", details = {}) =>
    res.status(429).json({ ok: false, status: 429, error: { message, details } }),

  serverErr: (res, err) => {
    const message = "Internal Server Error";
    const details = config.isProduction ? {} : { reason: err?.message };
    res.status(500).json({ ok: false, status: 500, error: { message, details } });
  },

  // Paginated response helper
  paginated: (res, data, pagination) =>
    res.status(200).json({
      ok: true,
      status: 200,
      data,
      meta: {
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total: pagination.total,
          totalPages: Math.ceil(pagination.total / pagination.limit),
          hasNext: pagination.page < Math.ceil(pagination.total / pagination.limit),
          hasPrev: pagination.page > 1,
        },
      },
    }),
};

module.exports = send;
