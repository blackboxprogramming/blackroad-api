const express = require("express");
const authService = require("../../services/auth.service");
const auditService = require("../../services/audit.service");
const totpService = require("../../services/totp.service");
const send = require("../../utils/response");
const { LoginSchema, RegisterSchema, validate } = require("../../utils/validation");
const { authenticate } = require("../../middleware/auth");

const router = express.Router();

// Register new user
router.post("/register", validate(RegisterSchema), async (req, res) => {
  try {
    const { username, password, role } = req.validated;

    // Only admins can create admin users (check if any admins exist first)
    const result = await authService.register(username, password, role);

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: result.data.id,
      action: "register",
      resourceType: "user",
      resourceId: result.data.id,
      newValue: { username, role },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, {
      id: result.data.id,
      username: result.data.username,
      role: result.data.role,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Login
router.post("/login", validate(LoginSchema), async (req, res) => {
  try {
    const { username, password } = req.validated;
    const result = await authService.login(username, password);

    if (result.error === "UNAUTHORIZED") {
      auditService.log({
        action: "login_failed",
        resourceType: "user",
        resourceId: username,
        ipAddress: req.ip,
        requestId: req.id,
      });
      return send.unauthorized(res, result.message);
    }

    auditService.log({
      userId: result.data.user.id,
      action: "login",
      resourceType: "user",
      resourceId: result.data.user.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get current user profile
router.get("/me", authenticate, (req, res) => {
  try {
    const user = authService.findById(req.user.id);
    if (!user) {
      return send.notFound(res, "User not found");
    }
    send.ok(res, {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.created_at,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Generate API key
router.post("/api-keys", authenticate, async (req, res) => {
  try {
    const { name, permissions = [], expiresIn } = req.body;

    if (!name || typeof name !== "string") {
      return send.bad(res, "API key name is required");
    }

    const result = await authService.generateApiKey(req.user.id, name, permissions, expiresIn);

    auditService.log({
      userId: req.user.id,
      action: "create_api_key",
      resourceType: "api_key",
      newValue: { name, permissions, expiresIn },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, {
      key: result.key,
      name: result.name,
      expiresAt: result.expiresAt,
      warning: "Store this key securely. It cannot be retrieved again.",
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Refresh token
router.post("/refresh", authenticate, (req, res) => {
  try {
    const user = authService.findById(req.user.id);
    if (!user) {
      return send.unauthorized(res, "User not found");
    }

    const token = authService.generateToken(user);

    send.ok(res, {
      token,
      expiresIn: require("../../config").jwtExpiresIn,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Two-Factor Authentication (2FA) ====================

// Check 2FA status
router.get("/2fa/status", authenticate, (req, res) => {
  try {
    const enabled = totpService.isEnabled(req.user.id);
    send.ok(res, { enabled });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Setup 2FA (generate secret and QR code)
router.post("/2fa/setup", authenticate, async (req, res) => {
  try {
    const user = authService.findById(req.user.id);
    if (!user) {
      return send.notFound(res, "User not found");
    }

    const result = await totpService.setup(req.user.id, user.username);

    if (result.error) {
      return send.bad(res, result.error);
    }

    send.ok(res, {
      secret: result.secret,
      qrCode: result.qrCode,
      message: result.message,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Verify and enable 2FA
router.post("/2fa/verify", authenticate, (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== "string") {
      return send.bad(res, "Verification code is required");
    }

    const result = totpService.verify(req.user.id, code);

    if (result.error) {
      return send.bad(res, result.error);
    }

    auditService.log({
      userId: req.user.id,
      action: "enable_2fa",
      resourceType: "user",
      resourceId: req.user.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, {
      enabled: true,
      backupCodes: result.backupCodes,
      message: result.message,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Validate 2FA code (for protected operations)
router.post("/2fa/validate", authenticate, (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== "string") {
      return send.bad(res, "Code is required");
    }

    const result = totpService.validate(req.user.id, code);

    if (!result.valid) {
      return send.unauthorized(res, "Invalid code");
    }

    send.ok(res, {
      valid: true,
      usedBackupCode: result.usedBackupCode || false,
      remainingBackupCodes: result.remainingBackupCodes,
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Disable 2FA
router.post("/2fa/disable", authenticate, (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== "string") {
      return send.bad(res, "Verification code is required");
    }

    const result = totpService.disable(req.user.id, code);

    if (result.error) {
      return send.bad(res, result.error);
    }

    auditService.log({
      userId: req.user.id,
      action: "disable_2fa",
      resourceType: "user",
      resourceId: req.user.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, { disabled: true });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Regenerate backup codes
router.post("/2fa/backup-codes", authenticate, (req, res) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== "string") {
      return send.bad(res, "Verification code is required");
    }

    const result = totpService.regenerateBackupCodes(req.user.id, code);

    if (result.error) {
      return send.bad(res, result.error);
    }

    auditService.log({
      userId: req.user.id,
      action: "regenerate_backup_codes",
      resourceType: "user",
      resourceId: req.user.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, {
      backupCodes: result.backupCodes,
      message: "New backup codes generated. Previous codes are now invalid.",
    });
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
