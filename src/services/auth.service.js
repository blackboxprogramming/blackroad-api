const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getDb } = require("../db");
const config = require("../config");

class AuthService {
  // Hash password with scrypt
  async hashPassword(password) {
    return new Promise((resolve, reject) => {
      const salt = crypto.randomBytes(16).toString("hex");
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) reject(err);
        resolve(`${salt}:${derivedKey.toString("hex")}`);
      });
    });
  }

  // Verify password
  async verifyPassword(password, hash) {
    return new Promise((resolve, reject) => {
      const [salt, key] = hash.split(":");
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) reject(err);
        resolve(crypto.timingSafeEqual(Buffer.from(key, "hex"), derivedKey));
      });
    });
  }

  // Generate JWT token
  generateToken(user) {
    return jwt.sign(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
      },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );
  }

  // Verify JWT token
  verifyToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch {
      return null;
    }
  }

  // Register new user
  async register(username, password, role = "user") {
    const db = getDb();

    // Check if user exists
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) {
      return { error: "CONFLICT", message: "Username already taken" };
    }

    const passwordHash = await this.hashPassword(password);

    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    `);
    const result = stmt.run(username, passwordHash, role);

    const user = this.findById(result.lastInsertRowid);
    return { data: user };
  }

  // Login user
  async login(username, password) {
    const db = getDb();

    const user = db
      .prepare("SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?")
      .get(username);

    if (!user) {
      return { error: "UNAUTHORIZED", message: "Invalid credentials" };
    }

    const validPassword = await this.verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return { error: "UNAUTHORIZED", message: "Invalid credentials" };
    }

    const token = this.generateToken(user);

    return {
      data: {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
        token,
        expiresIn: config.jwtExpiresIn,
      },
    };
  }

  // Find user by ID
  findById(id) {
    const db = getDb();
    const user = db
      .prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?")
      .get(id);
    return user || null;
  }

  // Find user by username
  findByUsername(username) {
    const db = getDb();
    const user = db
      .prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE username = ?")
      .get(username);
    return user || null;
  }

  // Generate API key
  async generateApiKey(userId, name, permissions = [], expiresIn = null) {
    const db = getDb();

    const key = `br_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(key).digest("hex");

    const expiresAt = expiresIn
      ? new Date(Date.now() + this._parseExpiry(expiresIn)).toISOString()
      : null;

    const stmt = db.prepare(`
      INSERT INTO api_keys (key_hash, name, user_id, permissions, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(keyHash, name, userId, JSON.stringify(permissions), expiresAt);

    return { key, name, expiresAt };
  }

  // Verify API key
  verifyApiKey(key) {
    const db = getDb();
    const keyHash = crypto.createHash("sha256").update(key).digest("hex");

    const apiKey = db
      .prepare(
        `
      SELECT ak.*, u.username, u.role as user_role
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE ak.key_hash = ?
    `
      )
      .get(keyHash);

    if (!apiKey) return null;

    // Check expiry
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      return null;
    }

    // Update last used
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(apiKey.id);

    return {
      userId: apiKey.user_id,
      username: apiKey.username,
      role: apiKey.user_role,
      permissions: JSON.parse(apiKey.permissions || "[]"),
    };
  }

  _parseExpiry(expiry) {
    const match = expiry.match(/^(\d+)([hdwmy])$/);
    if (!match) return 24 * 60 * 60 * 1000; // Default 24h

    const [, num, unit] = match;
    const multipliers = {
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      m: 30 * 24 * 60 * 60 * 1000,
      y: 365 * 24 * 60 * 60 * 1000,
    };
    return parseInt(num) * multipliers[unit];
  }
}

module.exports = new AuthService();
