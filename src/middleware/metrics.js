const config = require("../config");

// Simple metrics collector
class MetricsCollector {
  constructor() {
    this.reset();
    this.startTime = Date.now();
  }

  reset() {
    this.counters = {
      http_requests_total: {},
      http_request_errors_total: {},
    };
    this.histograms = {
      http_request_duration_seconds: [],
    };
    this.gauges = {
      nodejs_heap_size_bytes: 0,
      nodejs_external_memory_bytes: 0,
      nodejs_active_handles: 0,
    };
  }

  // Increment counter
  incCounter(name, labels = {}) {
    const key = this._labelsToKey(labels);
    if (!this.counters[name]) {
      this.counters[name] = {};
    }
    this.counters[name][key] = (this.counters[name][key] || 0) + 1;
  }

  // Record histogram value
  recordHistogram(name, value, labels = {}) {
    if (!this.histograms[name]) {
      this.histograms[name] = [];
    }
    this.histograms[name].push({ value, labels, timestamp: Date.now() });

    // Keep only last 1000 entries
    if (this.histograms[name].length > 1000) {
      this.histograms[name] = this.histograms[name].slice(-1000);
    }
  }

  // Set gauge value
  setGauge(name, value) {
    this.gauges[name] = value;
  }

  // Update Node.js metrics
  updateNodeMetrics() {
    const mem = process.memoryUsage();
    this.setGauge("nodejs_heap_size_bytes", mem.heapUsed);
    this.setGauge("nodejs_external_memory_bytes", mem.external);
    this.setGauge("nodejs_rss_bytes", mem.rss);
    this.setGauge("nodejs_heap_total_bytes", mem.heapTotal);

    // Active handles (approximate)
    if (process._getActiveHandles) {
      this.setGauge("nodejs_active_handles", process._getActiveHandles().length);
    }
  }

  // Get Prometheus format output
  toPrometheus() {
    this.updateNodeMetrics();
    const lines = [];
    const uptime = (Date.now() - this.startTime) / 1000;

    // Process info
    lines.push("# HELP process_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE process_uptime_seconds gauge");
    lines.push(`process_uptime_seconds ${uptime}`);

    // Counters
    for (const [name, values] of Object.entries(this.counters)) {
      lines.push(`# HELP ${name} Counter metric`);
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of Object.entries(values)) {
        const labelStr = labels ? `{${labels}}` : "";
        lines.push(`${name}${labelStr} ${value}`);
      }
    }

    // Gauges
    for (const [name, value] of Object.entries(this.gauges)) {
      lines.push(`# HELP ${name} Gauge metric`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    // Histogram summaries
    for (const [name, entries] of Object.entries(this.histograms)) {
      if (entries.length === 0) continue;

      const values = entries.map((e) => e.value).sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      const count = values.length;

      lines.push(`# HELP ${name} Histogram metric`);
      lines.push(`# TYPE ${name} histogram`);
      lines.push(`${name}_sum ${sum}`);
      lines.push(`${name}_count ${count}`);

      // Quantiles
      const quantiles = [0.5, 0.9, 0.95, 0.99];
      for (const q of quantiles) {
        const idx = Math.floor(count * q);
        lines.push(`${name}{quantile="${q}"} ${values[idx] || 0}`);
      }
    }

    return lines.join("\n");
  }

  // Get JSON format output
  toJSON() {
    this.updateNodeMetrics();
    const uptime = (Date.now() - this.startTime) / 1000;

    return {
      uptime_seconds: uptime,
      counters: this.counters,
      gauges: this.gauges,
      histograms: Object.fromEntries(
        Object.entries(this.histograms).map(([name, entries]) => {
          const values = entries.map((e) => e.value);
          return [
            name,
            {
              count: values.length,
              sum: values.reduce((a, b) => a + b, 0),
              avg: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0,
              min: Math.min(...values) || 0,
              max: Math.max(...values) || 0,
            },
          ];
        })
      ),
    };
  }

  _labelsToKey(labels) {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }
}

// Singleton instance
const metrics = new MetricsCollector();

// Middleware to collect request metrics
const metricsMiddleware = (req, res, next) => {
  if (!config.metricsEnabled) return next();

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = {
      method: req.method,
      path: req.route?.path || req.path,
      status: res.statusCode,
    };

    metrics.incCounter("http_requests_total", labels);
    metrics.recordHistogram("http_request_duration_seconds", duration, labels);

    if (res.statusCode >= 400) {
      metrics.incCounter("http_request_errors_total", labels);
    }
  });

  next();
};

module.exports = { metrics, metricsMiddleware };
