const { getDb } = require("../db");
const { logger } = require("../middleware/logger");
const websocketService = require("./websocket.service");

class NotificationService {
  constructor() {
    this.channels = new Map(); // channelType -> handler
    this._registerDefaultChannels();
  }

  // Initialize notification tables
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        data TEXT DEFAULT '{}',
        priority TEXT DEFAULT 'normal',
        read INTEGER DEFAULT 0,
        read_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
      );

      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL,
        channel TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        PRIMARY KEY (user_id, notification_type, channel)
      );

      CREATE TABLE IF NOT EXISTS notification_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL,
        config TEXT NOT NULL,
        verified INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
    `);
  }

  _registerDefaultChannels() {
    // In-app notifications (always available)
    this.channels.set("in_app", async (notification, _config) => {
      // Store in database (already done in send())
      // Push via WebSocket if user is connected
      websocketService.broadcast(`user:${notification.userId}`, {
        type: "notification",
        notification,
      });
      return { success: true };
    });

    // Webhook channel
    this.channels.set("webhook", async (notification, config) => {
      if (!config.url) {
        return { success: false, error: "No webhook URL configured" };
      }

      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...config.headers,
          },
          body: JSON.stringify({
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data,
            priority: notification.priority,
            timestamp: notification.createdAt,
          }),
          signal: AbortSignal.timeout(10000),
        });

        return { success: response.ok, status: response.status };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // Slack channel
    this.channels.set("slack", async (notification, config) => {
      if (!config.webhookUrl) {
        return { success: false, error: "No Slack webhook URL configured" };
      }

      const color = notification.priority === "urgent" ? "danger" :
                   notification.priority === "high" ? "warning" : "good";

      try {
        const response = await fetch(config.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            attachments: [{
              color,
              title: notification.title,
              text: notification.message,
              footer: "BlackRoad API",
              ts: Math.floor(Date.now() / 1000),
            }],
          }),
          signal: AbortSignal.timeout(10000),
        });

        return { success: response.ok };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

  // Send a notification
  async send(userId, { type, title, message, data = {}, priority = "normal", channels = ["in_app"] }) {
    const db = getDb();

    // Store notification
    const result = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, data, priority)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, type, title, message, JSON.stringify(data), priority);

    const notification = {
      id: result.lastInsertRowid,
      userId,
      type,
      title,
      message,
      data,
      priority,
      read: false,
      createdAt: new Date().toISOString(),
    };

    // Get user's channel configs
    const userChannels = db.prepare(`
      SELECT channel_type, config FROM notification_channels
      WHERE user_id = ? AND verified = 1
    `).all(userId);

    const channelConfigs = {};
    for (const ch of userChannels) {
      channelConfigs[ch.channel_type] = JSON.parse(ch.config);
    }

    // Send through each channel
    const deliveryResults = [];
    for (const channel of channels) {
      const handler = this.channels.get(channel);
      if (!handler) {
        deliveryResults.push({ channel, success: false, error: "Unknown channel" });
        continue;
      }

      // Check if user has preferences disabled for this type/channel
      const pref = db.prepare(`
        SELECT enabled FROM notification_preferences
        WHERE user_id = ? AND notification_type = ? AND channel = ?
      `).get(userId, type, channel);

      if (pref && !pref.enabled) {
        deliveryResults.push({ channel, success: false, error: "Disabled by user" });
        continue;
      }

      try {
        const result = await handler(notification, channelConfigs[channel] || {});
        deliveryResults.push({ channel, ...result });
      } catch (err) {
        deliveryResults.push({ channel, success: false, error: err.message });
      }
    }

    logger.info({ notificationId: notification.id, userId, type, channels }, "Notification sent");

    return { notification, delivery: deliveryResults };
  }

  // Send notification to multiple users
  async broadcast({ type, title, message, data = {}, priority = "normal", userIds = [], role }) {
    const db = getDb();

    let targetUsers = userIds;
    if (role) {
      const users = db.prepare("SELECT id FROM users WHERE role = ?").all(role);
      targetUsers = users.map((u) => u.id);
    }

    const results = [];
    for (const userId of targetUsers) {
      const result = await this.send(userId, { type, title, message, data, priority });
      results.push({ userId, ...result });
    }

    return { sentCount: results.length, results };
  }

  // Get user's notifications
  getNotifications(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    let query = "SELECT * FROM notifications WHERE user_id = ?";
    const params = [userId];

    if (unreadOnly) {
      query += " AND read = 0";
    }

    const total = db.prepare(query.replace("*", "COUNT(*) as count")).get(...params).count;

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const notifications = db.prepare(query).all(...params);

    return {
      data: notifications.map(this._format),
      pagination: { page, limit, total },
    };
  }

  // Get unread count
  getUnreadCount(userId) {
    const db = getDb();
    return db.prepare("SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0")
      .get(userId).count;
  }

  // Mark as read
  markAsRead(notificationId, userId) {
    const db = getDb();
    const result = db.prepare(`
      UPDATE notifications SET read = 1, read_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(notificationId, userId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Notification not found" };
    }

    return { data: { id: notificationId, read: true } };
  }

  // Mark all as read
  markAllAsRead(userId) {
    const db = getDb();
    const result = db.prepare(`
      UPDATE notifications SET read = 1, read_at = datetime('now')
      WHERE user_id = ? AND read = 0
    `).run(userId);

    return { data: { markedCount: result.changes } };
  }

  // Delete notification
  delete(notificationId, userId) {
    const db = getDb();
    const result = db.prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?")
      .run(notificationId, userId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Notification not found" };
    }

    return { data: { deleted: true } };
  }

  // Clear old notifications
  clearOld(userId, olderThanDays = 30) {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM notifications
      WHERE user_id = ? AND created_at < datetime('now', '-${olderThanDays} days')
    `).run(userId);

    return { data: { deletedCount: result.changes } };
  }

  // ==================== Channel Management ====================

  // Add notification channel for user
  addChannel(userId, channelType, config) {
    const db = getDb();

    try {
      const result = db.prepare(`
        INSERT INTO notification_channels (user_id, channel_type, config)
        VALUES (?, ?, ?)
      `).run(userId, channelType, JSON.stringify(config));

      return {
        data: {
          id: result.lastInsertRowid,
          channelType,
          verified: false,
        },
      };
    } catch (err) {
      return { error: "FAILED", message: err.message };
    }
  }

  // Verify channel
  verifyChannel(channelId, userId) {
    const db = getDb();
    const result = db.prepare(`
      UPDATE notification_channels SET verified = 1
      WHERE id = ? AND user_id = ?
    `).run(channelId, userId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Channel not found" };
    }

    return { data: { verified: true } };
  }

  // Remove channel
  removeChannel(channelId, userId) {
    const db = getDb();
    const result = db.prepare("DELETE FROM notification_channels WHERE id = ? AND user_id = ?")
      .run(channelId, userId);

    if (result.changes === 0) {
      return { error: "NOT_FOUND", message: "Channel not found" };
    }

    return { data: { removed: true } };
  }

  // Get user's channels
  getUserChannels(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT id, channel_type, verified, created_at
      FROM notification_channels
      WHERE user_id = ?
    `).all(userId).map((c) => ({
      id: c.id,
      channelType: c.channel_type,
      verified: Boolean(c.verified),
      createdAt: c.created_at,
    }));
  }

  // ==================== Preferences ====================

  // Set preference
  setPreference(userId, notificationType, channel, enabled) {
    const db = getDb();

    db.prepare(`
      INSERT INTO notification_preferences (user_id, notification_type, channel, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, notification_type, channel)
      DO UPDATE SET enabled = excluded.enabled
    `).run(userId, notificationType, channel, enabled ? 1 : 0);

    return { data: { notificationType, channel, enabled } };
  }

  // Get user preferences
  getPreferences(userId) {
    const db = getDb();
    const prefs = db.prepare("SELECT * FROM notification_preferences WHERE user_id = ?")
      .all(userId);

    const result = {};
    for (const pref of prefs) {
      if (!result[pref.notification_type]) {
        result[pref.notification_type] = {};
      }
      result[pref.notification_type][pref.channel] = Boolean(pref.enabled);
    }

    return result;
  }

  _format(n) {
    return {
      id: n.id,
      userId: n.user_id,
      type: n.type,
      title: n.title,
      message: n.message,
      data: JSON.parse(n.data || "{}"),
      priority: n.priority,
      read: Boolean(n.read),
      readAt: n.read_at,
      createdAt: n.created_at,
    };
  }
}

module.exports = new NotificationService();
