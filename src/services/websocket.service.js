const WebSocket = require("ws");
const { logger } = require("../middleware/logger");
const authService = require("./auth.service");

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // Map of authenticated clients
    this.subscriptions = new Map(); // Map of topic -> Set of clients
  }

  // Initialize WebSocket server
  init(server) {
    this.wss = new WebSocket.Server({ server, path: "/ws" });

    this.wss.on("connection", (ws, _req) => {
      const clientId = this._generateClientId();
      ws.clientId = clientId;
      ws.isAlive = true;
      ws.isAuthenticated = false;
      ws.subscriptions = new Set();

      logger.info({ clientId }, "WebSocket client connected");

      // Send welcome message
      this._send(ws, {
        type: "welcome",
        clientId,
        message: "Connected to BlackRoad WebSocket. Please authenticate.",
      });

      ws.on("pong", () => {
        ws.isAlive = true;
      });

      ws.on("message", (data) => {
        this._handleMessage(ws, data);
      });

      ws.on("close", () => {
        this._handleDisconnect(ws);
      });

      ws.on("error", (err) => {
        logger.error({ clientId, err }, "WebSocket error");
      });
    });

    // Heartbeat interval to detect dead connections
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          logger.info({ clientId: ws.clientId }, "Terminating inactive WebSocket");
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    logger.info("WebSocket server initialized on /ws");
    return this;
  }

  // Handle incoming messages
  _handleMessage(ws, data) {
    try {
      const message = JSON.parse(data.toString());
      const { type, payload } = message;

      switch (type) {
        case "auth":
          this._handleAuth(ws, payload);
          break;
        case "subscribe":
          this._handleSubscribe(ws, payload);
          break;
        case "unsubscribe":
          this._handleUnsubscribe(ws, payload);
          break;
        case "ping":
          this._send(ws, { type: "pong", timestamp: Date.now() });
          break;
        default:
          this._send(ws, { type: "error", message: `Unknown message type: ${type}` });
      }
    } catch {
      this._send(ws, { type: "error", message: "Invalid JSON message" });
    }
  }

  // Authenticate client
  _handleAuth(ws, payload) {
    const { token, apiKey } = payload || {};

    let user = null;

    if (token) {
      const decoded = authService.verifyToken(token);
      if (decoded) {
        user = { id: decoded.sub, username: decoded.username, role: decoded.role };
      }
    } else if (apiKey) {
      const keyData = authService.verifyApiKey(apiKey);
      if (keyData) {
        user = { id: keyData.userId, username: keyData.username, role: keyData.role };
      }
    }

    if (user) {
      ws.isAuthenticated = true;
      ws.user = user;
      this.clients.set(ws.clientId, ws);

      this._send(ws, {
        type: "auth_success",
        user: { id: user.id, username: user.username, role: user.role },
      });
      logger.info({ clientId: ws.clientId, username: user.username }, "WebSocket authenticated");
    } else {
      this._send(ws, { type: "auth_error", message: "Invalid credentials" });
    }
  }

  // Subscribe to topics
  _handleSubscribe(ws, payload) {
    if (!ws.isAuthenticated) {
      return this._send(ws, { type: "error", message: "Authentication required" });
    }

    const { topics } = payload || {};
    if (!Array.isArray(topics)) {
      return this._send(ws, { type: "error", message: "topics must be an array" });
    }

    const validTopics = ["agents", "agents:*", "audit", "system"];
    const subscribedTopics = [];

    for (const topic of topics) {
      // Check if topic is valid or matches pattern
      const isValid = validTopics.some((t) => {
        if (t.endsWith(":*")) {
          return topic.startsWith(t.slice(0, -1));
        }
        return t === topic || topic.startsWith("agents:");
      });

      if (isValid) {
        if (!this.subscriptions.has(topic)) {
          this.subscriptions.set(topic, new Set());
        }
        this.subscriptions.get(topic).add(ws.clientId);
        ws.subscriptions.add(topic);
        subscribedTopics.push(topic);
      }
    }

    this._send(ws, { type: "subscribed", topics: subscribedTopics });
    logger.info({ clientId: ws.clientId, topics: subscribedTopics }, "Client subscribed");
  }

  // Unsubscribe from topics
  _handleUnsubscribe(ws, payload) {
    const { topics } = payload || {};
    if (!Array.isArray(topics)) {
      return this._send(ws, { type: "error", message: "topics must be an array" });
    }

    for (const topic of topics) {
      if (this.subscriptions.has(topic)) {
        this.subscriptions.get(topic).delete(ws.clientId);
      }
      ws.subscriptions.delete(topic);
    }

    this._send(ws, { type: "unsubscribed", topics });
  }

  // Handle client disconnect
  _handleDisconnect(ws) {
    logger.info({ clientId: ws.clientId }, "WebSocket client disconnected");

    // Remove from all subscriptions
    for (const topic of ws.subscriptions) {
      if (this.subscriptions.has(topic)) {
        this.subscriptions.get(topic).delete(ws.clientId);
      }
    }

    this.clients.delete(ws.clientId);
  }

  // Broadcast to topic subscribers
  broadcast(topic, data) {
    const message = { type: "event", topic, data, timestamp: Date.now() };

    // Direct topic subscribers
    if (this.subscriptions.has(topic)) {
      for (const clientId of this.subscriptions.get(topic)) {
        const client = this.clients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
          this._send(client, message);
        }
      }
    }

    // Wildcard subscribers (e.g., agents:* matches agents:lucidia)
    const parts = topic.split(":");
    if (parts.length > 1) {
      const wildcardTopic = `${parts[0]}:*`;
      if (this.subscriptions.has(wildcardTopic)) {
        for (const clientId of this.subscriptions.get(wildcardTopic)) {
          const client = this.clients.get(clientId);
          if (client && client.readyState === WebSocket.OPEN) {
            this._send(client, message);
          }
        }
      }
    }
  }

  // Emit agent event
  emitAgentEvent(action, agent) {
    this.broadcast("agents", { action, agent });
    this.broadcast(`agents:${agent.id}`, { action, agent });
  }

  // Emit system event
  emitSystemEvent(event, data) {
    this.broadcast("system", { event, ...data });
  }

  // Send message to client
  _send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // Generate unique client ID
  _generateClientId() {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Get connection stats
  getStats() {
    return {
      totalConnections: this.wss?.clients?.size || 0,
      authenticatedClients: this.clients.size,
      subscriptions: Object.fromEntries(
        Array.from(this.subscriptions.entries()).map(([topic, clients]) => [topic, clients.size])
      ),
    };
  }

  // Shutdown
  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.wss) {
      this.wss.close();
    }
  }
}

module.exports = new WebSocketService();
