const express = require("express");
const permissionService = require("../../services/permission.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate, authorize } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schemas
const RoleSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z_]+$/),
  description: z.string().max(200).optional(),
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

// ==================== Roles ====================

// Get all roles
router.get("/roles", authenticate, (req, res) => {
  try {
    const roles = permissionService.getAllRoles();
    send.ok(res, roles);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create role
router.post("/roles", authenticate, authorize("admin"), validate(RoleSchema), (req, res) => {
  try {
    const result = permissionService.createRole(req.validated.name, req.validated.description);

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "role",
      resourceId: result.data.id.toString(),
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete role
router.delete("/roles/:id", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.deleteRole(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    if (result.error === "FORBIDDEN") {
      return send.forbidden(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "role",
      resourceId: req.params.id,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get role permissions
router.get("/roles/:id/permissions", authenticate, (req, res) => {
  try {
    const permissions = permissionService.getRolePermissions(parseInt(req.params.id));
    send.ok(res, permissions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Add permission to role
router.post("/roles/:roleId/permissions/:permissionId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.addPermissionToRole(
      parseInt(req.params.roleId),
      parseInt(req.params.permissionId)
    );

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "add_permission_to_role",
      resourceType: "role",
      resourceId: req.params.roleId,
      newValue: { permissionId: parseInt(req.params.permissionId) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Remove permission from role
router.delete("/roles/:roleId/permissions/:permissionId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.removePermissionFromRole(
      parseInt(req.params.roleId),
      parseInt(req.params.permissionId)
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "remove_permission_from_role",
      resourceType: "role",
      resourceId: req.params.roleId,
      oldValue: { permissionId: parseInt(req.params.permissionId) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== Permissions ====================

// Get all permissions
router.get("/", authenticate, (req, res) => {
  try {
    const permissions = permissionService.getAllPermissions();
    send.ok(res, permissions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get permissions by resource
router.get("/resource/:resource", authenticate, (req, res) => {
  try {
    const permissions = permissionService.getPermissionsByResource(req.params.resource);
    send.ok(res, permissions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== User Roles ====================

// Get user's roles
router.get("/users/:userId/roles", authenticate, (req, res) => {
  try {
    // Users can see their own roles, admins can see any user's roles
    if (req.user.id !== parseInt(req.params.userId) && req.user.role !== "admin") {
      return send.forbidden(res, "Cannot view other user's roles");
    }

    const roles = permissionService.getUserRoles(parseInt(req.params.userId));
    send.ok(res, roles);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Assign role to user
router.post("/users/:userId/roles/:roleId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.assignRoleToUser(
      parseInt(req.params.userId),
      parseInt(req.params.roleId),
      req.user.id
    );

    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "assign_role",
      resourceType: "user",
      resourceId: req.params.userId,
      newValue: { roleId: parseInt(req.params.roleId) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Remove role from user
router.delete("/users/:userId/roles/:roleId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.removeRoleFromUser(
      parseInt(req.params.userId),
      parseInt(req.params.roleId)
    );

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "remove_role",
      resourceType: "user",
      resourceId: req.params.userId,
      oldValue: { roleId: parseInt(req.params.roleId) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// ==================== User Permissions ====================

// Get user's effective permissions
router.get("/users/:userId", authenticate, (req, res) => {
  try {
    // Users can see their own permissions, admins can see any user's permissions
    if (req.user.id !== parseInt(req.params.userId) && req.user.role !== "admin") {
      return send.forbidden(res, "Cannot view other user's permissions");
    }

    const permissions = permissionService.getUserPermissions(parseInt(req.params.userId));
    send.ok(res, permissions);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Grant direct permission to user
router.post("/users/:userId/:permissionId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.grantPermissionToUser(
      parseInt(req.params.userId),
      parseInt(req.params.permissionId),
      req.user.id
    );

    auditService.log({
      userId: req.user.id,
      action: "grant_permission",
      resourceType: "user",
      resourceId: req.params.userId,
      newValue: { permissionId: parseInt(req.params.permissionId) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Revoke direct permission from user
router.delete("/users/:userId/:permissionId", authenticate, authorize("admin"), (req, res) => {
  try {
    const result = permissionService.revokePermissionFromUser(
      parseInt(req.params.userId),
      parseInt(req.params.permissionId),
      req.user.id
    );

    auditService.log({
      userId: req.user.id,
      action: "revoke_permission",
      resourceType: "user",
      resourceId: req.params.userId,
      oldValue: { permissionId: parseInt(req.params.permissionId) },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Check if user has specific permission
router.get("/check", authenticate, (req, res) => {
  try {
    const { permission } = req.query;
    if (!permission) {
      return send.bad(res, "permission query parameter is required");
    }

    const hasPermission = permissionService.hasPermission(req.user.id, permission);
    send.ok(res, { permission, hasPermission });
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
