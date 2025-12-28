const { getDb } = require("../db");

class PermissionService {
  // Initialize permission tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        is_system INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        resource TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
        permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
        granted_by INTEGER REFERENCES users(id),
        granted_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
        granted INTEGER DEFAULT 1,
        granted_by INTEGER REFERENCES users(id),
        granted_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, permission_id)
      );

      CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
      CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
    `);

    // Seed default roles and permissions
    this._seedDefaults();
  }

  _seedDefaults() {
    const db = getDb();

    // Check if already seeded
    const existingRoles = db.prepare("SELECT COUNT(*) as count FROM roles").get().count;
    if (existingRoles > 0) return;

    // Create default roles
    const roles = [
      { name: "admin", description: "Full system access", isSystem: 1 },
      { name: "operator", description: "Manage agents and commands", isSystem: 1 },
      { name: "viewer", description: "Read-only access", isSystem: 1 },
      { name: "user", description: "Basic user access", isSystem: 1 },
    ];

    const insertRole = db.prepare("INSERT INTO roles (name, description, is_system) VALUES (?, ?, ?)");
    for (const role of roles) {
      insertRole.run(role.name, role.description, role.isSystem);
    }

    // Create default permissions
    const permissions = [
      // Agents
      { name: "agents:read", resource: "agents", action: "read", description: "View agents" },
      { name: "agents:create", resource: "agents", action: "create", description: "Create agents" },
      { name: "agents:update", resource: "agents", action: "update", description: "Update agents" },
      { name: "agents:delete", resource: "agents", action: "delete", description: "Delete agents" },
      { name: "agents:command", resource: "agents", action: "command", description: "Issue commands" },
      // Users
      { name: "users:read", resource: "users", action: "read", description: "View users" },
      { name: "users:create", resource: "users", action: "create", description: "Create users" },
      { name: "users:update", resource: "users", action: "update", description: "Update users" },
      { name: "users:delete", resource: "users", action: "delete", description: "Delete users" },
      // Webhooks
      { name: "webhooks:read", resource: "webhooks", action: "read", description: "View webhooks" },
      { name: "webhooks:manage", resource: "webhooks", action: "manage", description: "Manage webhooks" },
      // Audit
      { name: "audit:read", resource: "audit", action: "read", description: "View audit logs" },
      { name: "audit:export", resource: "audit", action: "export", description: "Export audit logs" },
      // Groups
      { name: "groups:read", resource: "groups", action: "read", description: "View groups" },
      { name: "groups:manage", resource: "groups", action: "manage", description: "Manage groups" },
      // System
      { name: "system:admin", resource: "system", action: "admin", description: "Full admin access" },
      { name: "system:metrics", resource: "system", action: "metrics", description: "View metrics" },
    ];

    const insertPerm = db.prepare(
      "INSERT INTO permissions (name, resource, action, description) VALUES (?, ?, ?, ?)"
    );
    for (const perm of permissions) {
      insertPerm.run(perm.name, perm.resource, perm.action, perm.description);
    }

    // Assign permissions to roles
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get();
    const operatorRole = db.prepare("SELECT id FROM roles WHERE name = 'operator'").get();
    const viewerRole = db.prepare("SELECT id FROM roles WHERE name = 'viewer'").get();

    const allPerms = db.prepare("SELECT id FROM permissions").all();
    const insertRolePerm = db.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)");

    // Admin gets all permissions
    for (const perm of allPerms) {
      insertRolePerm.run(adminRole.id, perm.id);
    }

    // Operator gets agent and group permissions
    const operatorPerms = db.prepare(
      "SELECT id FROM permissions WHERE resource IN ('agents', 'groups') OR name = 'system:metrics'"
    ).all();
    for (const perm of operatorPerms) {
      insertRolePerm.run(operatorRole.id, perm.id);
    }

    // Viewer gets read permissions
    const viewerPerms = db.prepare("SELECT id FROM permissions WHERE action = 'read'").all();
    for (const perm of viewerPerms) {
      insertRolePerm.run(viewerRole.id, perm.id);
    }
  }

  // ==================== Roles ====================

  // Get all roles
  getAllRoles() {
    const db = getDb();
    const roles = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM role_permissions WHERE role_id = r.id) as permission_count,
        (SELECT COUNT(*) FROM user_roles WHERE role_id = r.id) as user_count
      FROM roles r
      ORDER BY r.is_system DESC, r.name
    `).all();

    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: Boolean(r.is_system),
      permissionCount: r.permission_count,
      userCount: r.user_count,
      createdAt: r.created_at,
    }));
  }

  // Create role
  createRole(name, description) {
    const db = getDb();

    try {
      const result = db.prepare("INSERT INTO roles (name, description) VALUES (?, ?)")
        .run(name, description);
      return { data: { id: result.lastInsertRowid, name, description } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Role already exists" };
      }
      throw err;
    }
  }

  // Delete role
  deleteRole(roleId) {
    const db = getDb();

    const role = db.prepare("SELECT * FROM roles WHERE id = ?").get(roleId);
    if (!role) {
      return { error: "NOT_FOUND", message: "Role not found" };
    }

    if (role.is_system) {
      return { error: "FORBIDDEN", message: "Cannot delete system role" };
    }

    db.prepare("DELETE FROM roles WHERE id = ?").run(roleId);
    return { data: { deleted: true } };
  }

  // Get role permissions
  getRolePermissions(roleId) {
    const db = getDb();
    return db.prepare(`
      SELECT p.* FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = ?
      ORDER BY p.resource, p.action
    `).all(roleId).map(this._formatPermission);
  }

  // Add permission to role
  addPermissionToRole(roleId, permissionId) {
    const db = getDb();

    try {
      db.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)")
        .run(roleId, permissionId);
      return { data: { added: true } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { error: "CONFLICT", message: "Permission already assigned" };
      }
      throw err;
    }
  }

  // Remove permission from role
  removePermissionFromRole(roleId, permissionId) {
    const db = getDb();
    const result = db.prepare("DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?")
      .run(roleId, permissionId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Permission not assigned to role" };
    }

    return { data: { removed: true } };
  }

  // ==================== Permissions ====================

  // Get all permissions
  getAllPermissions() {
    const db = getDb();
    return db.prepare("SELECT * FROM permissions ORDER BY resource, action").all()
      .map(this._formatPermission);
  }

  // Get permissions by resource
  getPermissionsByResource(resource) {
    const db = getDb();
    return db.prepare("SELECT * FROM permissions WHERE resource = ? ORDER BY action")
      .all(resource).map(this._formatPermission);
  }

  // ==================== User Roles ====================

  // Assign role to user
  assignRoleToUser(userId, roleId, grantedBy = null) {
    const db = getDb();

    try {
      db.prepare("INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)")
        .run(userId, roleId, grantedBy);
      return { data: { assigned: true } };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return { error: "CONFLICT", message: "Role already assigned" };
      }
      throw err;
    }
  }

  // Remove role from user
  removeRoleFromUser(userId, roleId) {
    const db = getDb();
    const result = db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?")
      .run(userId, roleId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Role not assigned to user" };
    }

    return { data: { removed: true } };
  }

  // Get user's roles
  getUserRoles(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT r.*, ur.granted_at, u.username as granted_by_username
      FROM roles r
      JOIN user_roles ur ON r.id = ur.role_id
      LEFT JOIN users u ON ur.granted_by = u.id
      WHERE ur.user_id = ?
    `).all(userId).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: Boolean(r.is_system),
      grantedAt: r.granted_at,
      grantedBy: r.granted_by_username,
    }));
  }

  // ==================== User Permissions ====================

  // Grant direct permission to user
  grantPermissionToUser(userId, permissionId, grantedBy = null) {
    const db = getDb();

    db.prepare(`
      INSERT INTO user_permissions (user_id, permission_id, granted, granted_by)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id, permission_id)
      DO UPDATE SET granted = 1, granted_by = excluded.granted_by, granted_at = datetime('now')
    `).run(userId, permissionId, grantedBy);

    return { data: { granted: true } };
  }

  // Revoke direct permission from user
  revokePermissionFromUser(userId, permissionId, grantedBy = null) {
    const db = getDb();

    db.prepare(`
      INSERT INTO user_permissions (user_id, permission_id, granted, granted_by)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(user_id, permission_id)
      DO UPDATE SET granted = 0, granted_by = excluded.granted_by, granted_at = datetime('now')
    `).run(userId, permissionId, grantedBy);

    return { data: { revoked: true } };
  }

  // Get user's effective permissions
  getUserPermissions(userId) {
    const db = getDb();

    // Get permissions from roles
    const rolePermissions = db.prepare(`
      SELECT DISTINCT p.* FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ?
    `).all(userId);

    // Get direct permissions
    const directPermissions = db.prepare(`
      SELECT p.*, up.granted FROM permissions p
      JOIN user_permissions up ON p.id = up.permission_id
      WHERE up.user_id = ?
    `).all(userId);

    // Merge permissions
    const permissions = new Map();

    for (const perm of rolePermissions) {
      permissions.set(perm.id, { ...this._formatPermission(perm), source: "role" });
    }

    for (const perm of directPermissions) {
      if (perm.granted) {
        permissions.set(perm.id, { ...this._formatPermission(perm), source: "direct" });
      } else {
        // Direct deny overrides role grants
        permissions.delete(perm.id);
      }
    }

    return Array.from(permissions.values());
  }

  // Check if user has permission
  hasPermission(userId, permissionName) {
    const permissions = this.getUserPermissions(userId);
    return permissions.some((p) => p.name === permissionName);
  }

  // Check if user has any of the permissions
  hasAnyPermission(userId, permissionNames) {
    const permissions = this.getUserPermissions(userId);
    const permSet = new Set(permissions.map((p) => p.name));
    return permissionNames.some((name) => permSet.has(name));
  }

  // Check if user has all of the permissions
  hasAllPermissions(userId, permissionNames) {
    const permissions = this.getUserPermissions(userId);
    const permSet = new Set(permissions.map((p) => p.name));
    return permissionNames.every((name) => permSet.has(name));
  }

  _formatPermission(p) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      resource: p.resource,
      action: p.action,
    };
  }
}

module.exports = new PermissionService();
