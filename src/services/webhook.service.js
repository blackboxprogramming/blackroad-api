const crypto = require("crypto");
const { getDb } = require("../db");
const { logger } = require("../middleware/logger");

class WebhookService {
  constructor() {
    this.retryDelays = [1000, 5000, 30000, 60000, 300000]; // Retry delays in ms
  }

  // Initialize webhooks table
  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        headers TEXT DEFAULT '{}',
        active INTEGER DEFAULT 1,
        user_id INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER REFERENCES webhooks(id),
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        attempts INTEGER DEFAULT 0,
        delivered_at TEXT,
        next_retry_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at);
    `);
  }

  // Create webhook
  create(data, userId) {
    const db = getDb();
    const { name, url, events = [], headers = {} } = data;
    const secret = crypto.randomBytes(32).toString("hex");

    const stmt = db.prepare(`
      INSERT INTO webhooks (name, url, secret, events, headers, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name, url, secret, JSON.stringify(events), JSON.stringify(headers), userId);

    return {
      id: result.lastInsertRowid,
      name,
      url,
      secret,
      events,
      active: true,
    };
  }

  // List webhooks for user
  findByUser(userId) {
    const db = getDb();
    const webhooks = db
      .prepare("SELECT * FROM webhooks WHERE user_id = ?")
      .all(userId);

    return webhooks.map(this._formatWebhook);
  }

  // Get webhook by ID
  findById(id) {
    const db = getDb();
    const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id);
    return webhook ? this._formatWebhook(webhook) : null;
  }

  // Update webhook
  update(id, data, userId) {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing || existing.userId !== userId) {
      return null;
    }

    const updates = [];
    const params = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      params.push(data.name);
    }
    if (data.url !== undefined) {
      updates.push("url = ?");
      params.push(data.url);
    }
    if (data.events !== undefined) {
      updates.push("events = ?");
      params.push(JSON.stringify(data.events));
    }
    if (data.headers !== undefined) {
      updates.push("headers = ?");
      params.push(JSON.stringify(data.headers));
    }
    if (data.active !== undefined) {
      updates.push("active = ?");
      params.push(data.active ? 1 : 0);
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    db.prepare(`UPDATE webhooks SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    return this.findById(id);
  }

  // Delete webhook
  delete(id, userId) {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing || existing.userId !== userId) {
      return false;
    }

    db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(id);
    db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    return true;
  }

  // Trigger webhooks for event
  async trigger(event, payload) {
    const db = getDb();

    // Find active webhooks that listen to this event
    const webhooks = db
      .prepare("SELECT * FROM webhooks WHERE active = 1")
      .all()
      .map(this._formatWebhook)
      .filter((w) => w.events.includes(event) || w.events.includes("*"));

    for (const webhook of webhooks) {
      await this._deliver(webhook, event, payload);
    }
  }

  // Deliver webhook
  async _deliver(webhook, event, payload, attempt = 1) {
    const db = getDb();
    const timestamp = Date.now();
    const signature = this._sign(JSON.stringify(payload), webhook.secret);

    // Create delivery record
    const delivery = db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event, payload, attempts)
      VALUES (?, ?, ?, ?)
    `).run(webhook.id, event, JSON.stringify(payload), attempt);

    const deliveryId = delivery.lastInsertRowid;

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": event,
          "X-Webhook-Signature": `sha256=${signature}`,
          "X-Webhook-Timestamp": timestamp.toString(),
          "X-Webhook-Delivery": deliveryId.toString(),
          ...webhook.headers,
        },
        body: JSON.stringify({
          event,
          payload,
          timestamp,
          webhookId: webhook.id,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const responseBody = await response.text().catch(() => "");

      // Update delivery record
      db.prepare(`
        UPDATE webhook_deliveries
        SET response_status = ?, response_body = ?, delivered_at = datetime('now')
        WHERE id = ?
      `).run(response.status, responseBody.slice(0, 10000), deliveryId);

      if (!response.ok && attempt < this.retryDelays.length) {
        // Schedule retry
        const nextRetry = new Date(Date.now() + this.retryDelays[attempt]);
        db.prepare("UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?")
          .run(nextRetry.toISOString(), deliveryId);

        logger.warn({ webhookId: webhook.id, event, attempt, status: response.status }, "Webhook delivery failed, scheduled retry");
      } else if (response.ok) {
        logger.info({ webhookId: webhook.id, event, deliveryId }, "Webhook delivered successfully");
      }
    } catch (err) {
      logger.error({ webhookId: webhook.id, event, err: err.message }, "Webhook delivery error");

      db.prepare(`
        UPDATE webhook_deliveries
        SET response_body = ?
        WHERE id = ?
      `).run(`Error: ${err.message}`, deliveryId);

      if (attempt < this.retryDelays.length) {
        const nextRetry = new Date(Date.now() + this.retryDelays[attempt]);
        db.prepare("UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?")
          .run(nextRetry.toISOString(), deliveryId);
      }
    }
  }

  // Get delivery history
  getDeliveries(webhookId, { page = 1, limit = 20 } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;

    const total = db.prepare("SELECT COUNT(*) as count FROM webhook_deliveries WHERE webhook_id = ?")
      .get(webhookId).count;

    const deliveries = db.prepare(`
      SELECT * FROM webhook_deliveries
      WHERE webhook_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(webhookId, limit, offset);

    return {
      data: deliveries.map((d) => ({
        id: d.id,
        event: d.event,
        payload: JSON.parse(d.payload),
        responseStatus: d.response_status,
        responseBody: d.response_body,
        attempts: d.attempts,
        deliveredAt: d.delivered_at,
        createdAt: d.created_at,
      })),
      pagination: { page, limit, total },
    };
  }

  // Create signature
  _sign(payload, secret) {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
  }

  // Format webhook from DB
  _formatWebhook(row) {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: row.secret,
      events: JSON.parse(row.events || "[]"),
      headers: JSON.parse(row.headers || "{}"),
      active: Boolean(row.active),
      userId: row.user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new WebhookService();
