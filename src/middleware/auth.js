const authService = require("../services/auth.service");
const send = require("../utils/response");

// Extract token from request
const extractToken = (req) => {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check for API key
  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    return { type: "apiKey", value: apiKey };
  }

  return null;
};

// Authentication middleware
const authenticate = (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return send.unauthorized(res, "Authentication required", {
      hint: "Provide a Bearer token or X-API-Key header",
    });
  }

  // Handle API key
  if (token.type === "apiKey") {
    const keyData = authService.verifyApiKey(token.value);
    if (!keyData) {
      return send.unauthorized(res, "Invalid or expired API key");
    }
    req.user = {
      id: keyData.userId,
      username: keyData.username,
      role: keyData.role,
      authType: "apiKey",
      permissions: keyData.permissions,
    };
    return next();
  }

  // Handle JWT
  const decoded = authService.verifyToken(token);
  if (!decoded) {
    return send.unauthorized(res, "Invalid or expired token");
  }

  req.user = {
    id: decoded.sub,
    username: decoded.username,
    role: decoded.role,
    authType: "jwt",
  };
  next();
};

// Optional authentication (doesn't fail if no token)
const optionalAuth = (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    req.user = null;
    return next();
  }

  if (token.type === "apiKey") {
    const keyData = authService.verifyApiKey(token.value);
    if (keyData) {
      req.user = {
        id: keyData.userId,
        username: keyData.username,
        role: keyData.role,
        authType: "apiKey",
        permissions: keyData.permissions,
      };
    }
    return next();
  }

  const decoded = authService.verifyToken(token);
  if (decoded) {
    req.user = {
      id: decoded.sub,
      username: decoded.username,
      role: decoded.role,
      authType: "jwt",
    };
  }
  next();
};

// Role-based authorization
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return send.unauthorized(res, "Authentication required");
    }

    if (!roles.includes(req.user.role)) {
      return send.forbidden(res, "Insufficient permissions", {
        required: roles,
        current: req.user.role,
      });
    }

    next();
  };
};

// Permission-based authorization (for API keys)
const requirePermission = (...permissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return send.unauthorized(res, "Authentication required");
    }

    // Admins have all permissions
    if (req.user.role === "admin") {
      return next();
    }

    // JWT users have all permissions for their role
    if (req.user.authType === "jwt") {
      return next();
    }

    // Check API key permissions
    const userPermissions = req.user.permissions || [];
    const hasPermission = permissions.some((p) => userPermissions.includes(p) || userPermissions.includes("*"));

    if (!hasPermission) {
      return send.forbidden(res, "API key lacks required permissions", {
        required: permissions,
        granted: userPermissions,
      });
    }

    next();
  };
};

module.exports = { authenticate, optionalAuth, authorize, requirePermission };
