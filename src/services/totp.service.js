const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const crypto = require("crypto");
const { getDb } = require("../db");

class TotpService {
  constructor() {
    // Configure authenticator
    authenticator.options = {
      step: 30, // 30 second window
      window: 1, // Allow 1 step before/after for clock drift
    };
  }

  // Initialize 2FA tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_totp (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        backup_codes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS totp_recovery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        success INTEGER,
        ip_address TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // Generate new TOTP secret
  generateSecret(username) {
    const secret = authenticator.generateSecret();
    const issuer = "BlackRoad";
    const otpauth = authenticator.keyuri(username, issuer, secret);

    return { secret, otpauth };
  }

  // Generate QR code as data URL
  async generateQRCode(otpauth) {
    return QRCode.toDataURL(otpauth);
  }

  // Setup 2FA for user (before verification)
  async setup(userId, username) {
    const db = getDb();

    // Check if already set up
    const existing = db.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(userId);
    if (existing?.enabled) {
      return { error: "2FA already enabled" };
    }

    const { secret, otpauth } = this.generateSecret(username);
    const qrCode = await this.generateQRCode(otpauth);

    // Store secret (not enabled yet)
    if (existing) {
      db.prepare("UPDATE user_totp SET secret = ?, updated_at = datetime('now') WHERE user_id = ?")
        .run(secret, userId);
    } else {
      db.prepare("INSERT INTO user_totp (user_id, secret) VALUES (?, ?)")
        .run(userId, secret);
    }

    return {
      secret,
      otpauth,
      qrCode,
      message: "Scan QR code with authenticator app, then verify with a code",
    };
  }

  // Verify and enable 2FA
  verify(userId, code) {
    const db = getDb();
    const totp = db.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(userId);

    if (!totp) {
      return { error: "2FA not set up" };
    }

    if (totp.enabled) {
      return { error: "2FA already enabled" };
    }

    const isValid = authenticator.verify({ token: code, secret: totp.secret });

    if (!isValid) {
      return { error: "Invalid verification code" };
    }

    // Generate backup codes
    const backupCodes = this._generateBackupCodes();
    const hashedCodes = backupCodes.map((c) => this._hashCode(c));

    // Enable 2FA
    db.prepare(`
      UPDATE user_totp
      SET enabled = 1, backup_codes = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(JSON.stringify(hashedCodes), userId);

    return {
      enabled: true,
      backupCodes,
      message: "2FA enabled. Save these backup codes securely.",
    };
  }

  // Validate TOTP code during login
  validate(userId, code) {
    const db = getDb();
    const totp = db.prepare("SELECT * FROM user_totp WHERE user_id = ? AND enabled = 1").get(userId);

    if (!totp) {
      return { valid: true, required: false }; // 2FA not enabled
    }

    // Check if it's a backup code
    const backupCodes = JSON.parse(totp.backup_codes || "[]");
    const hashedInput = this._hashCode(code);
    const backupIndex = backupCodes.findIndex((c) => c === hashedInput);

    if (backupIndex !== -1) {
      // Use backup code (one-time)
      backupCodes.splice(backupIndex, 1);
      db.prepare("UPDATE user_totp SET backup_codes = ? WHERE user_id = ?")
        .run(JSON.stringify(backupCodes), userId);

      return { valid: true, usedBackupCode: true, remainingBackupCodes: backupCodes.length };
    }

    // Verify TOTP code
    const isValid = authenticator.verify({ token: code, secret: totp.secret });

    return { valid: isValid, required: true };
  }

  // Check if user has 2FA enabled
  isEnabled(userId) {
    const db = getDb();
    const totp = db.prepare("SELECT enabled FROM user_totp WHERE user_id = ?").get(userId);
    return Boolean(totp?.enabled);
  }

  // Disable 2FA
  disable(userId, code) {
    const db = getDb();
    const totp = db.prepare("SELECT * FROM user_totp WHERE user_id = ? AND enabled = 1").get(userId);

    if (!totp) {
      return { error: "2FA not enabled" };
    }

    // Verify code before disabling
    const isValid = authenticator.verify({ token: code, secret: totp.secret });

    if (!isValid) {
      return { error: "Invalid verification code" };
    }

    db.prepare("DELETE FROM user_totp WHERE user_id = ?").run(userId);

    return { disabled: true };
  }

  // Regenerate backup codes
  regenerateBackupCodes(userId, code) {
    const db = getDb();
    const totp = db.prepare("SELECT * FROM user_totp WHERE user_id = ? AND enabled = 1").get(userId);

    if (!totp) {
      return { error: "2FA not enabled" };
    }

    // Verify code before regenerating
    const isValid = authenticator.verify({ token: code, secret: totp.secret });

    if (!isValid) {
      return { error: "Invalid verification code" };
    }

    const backupCodes = this._generateBackupCodes();
    const hashedCodes = backupCodes.map((c) => this._hashCode(c));

    db.prepare("UPDATE user_totp SET backup_codes = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(JSON.stringify(hashedCodes), userId);

    return { backupCodes };
  }

  // Generate backup codes
  _generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      codes.push(crypto.randomBytes(4).toString("hex").toUpperCase());
    }
    return codes;
  }

  // Hash backup code for storage
  _hashCode(code) {
    return crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
  }
}

module.exports = new TotpService();
