const { getDb } = require("../db");
const agentControlService = require("./agent-control.service");
const websocketService = require("./websocket.service");
const webhookService = require("./webhook.service");

class WorkflowService {
  constructor() {
    this.runningWorkflows = new Map();
  }

  initTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        trigger_type TEXT DEFAULT 'manual', -- 'manual', 'schedule', 'event', 'webhook'
        trigger_config TEXT DEFAULT '{}',
        steps TEXT NOT NULL, -- JSON array of workflow steps
        variables TEXT DEFAULT '{}', -- Default variables
        enabled INTEGER DEFAULT 1,
        timeout_seconds INTEGER DEFAULT 3600,
        retry_on_failure INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS workflow_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed', 'cancelled'
        trigger_type TEXT,
        trigger_data TEXT,
        variables TEXT DEFAULT '{}',
        current_step INTEGER DEFAULT 0,
        step_results TEXT DEFAULT '[]',
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS workflow_step_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id INTEGER REFERENCES workflow_executions(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        step_name TEXT,
        status TEXT DEFAULT 'pending',
        input TEXT,
        output TEXT,
        error TEXT,
        duration_ms INTEGER,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
      CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_step_logs_execution ON workflow_step_logs(execution_id);
    `);
  }

  // Create a workflow
  create(data, userId) {
    const db = getDb();
    const {
      name,
      description,
      trigger_type = "manual",
      trigger_config = {},
      steps,
      variables = {},
      timeout_seconds = 3600,
      retry_on_failure = false,
      max_retries = 3,
    } = data;

    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return { error: "VALIDATION", message: "At least one step is required" };
    }

    // Validate steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.type) {
        return { error: "VALIDATION", message: `Step ${i + 1} missing type` };
      }
      if (!["command", "wait", "condition", "parallel", "notify", "http"].includes(step.type)) {
        return { error: "VALIDATION", message: `Step ${i + 1} has invalid type: ${step.type}` };
      }
    }

    try {
      const result = db.prepare(`
        INSERT INTO workflows (name, description, trigger_type, trigger_config, steps, variables, timeout_seconds, retry_on_failure, max_retries, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        description || null,
        trigger_type,
        JSON.stringify(trigger_config),
        JSON.stringify(steps),
        JSON.stringify(variables),
        timeout_seconds,
        retry_on_failure ? 1 : 0,
        max_retries,
        userId
      );

      const workflow = this.findById(result.lastInsertRowid);
      webhookService.trigger("workflow.created", { workflow });
      return { data: workflow };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Workflow name already exists" };
      }
      throw err;
    }
  }

  // Find workflow by ID
  findById(id) {
    const db = getDb();
    const workflow = db.prepare(`
      SELECT w.*, u.username as created_by_username,
        (SELECT COUNT(*) FROM workflow_executions WHERE workflow_id = w.id) as execution_count,
        (SELECT COUNT(*) FROM workflow_executions WHERE workflow_id = w.id AND status = 'completed') as success_count
      FROM workflows w
      LEFT JOIN users u ON w.created_by = u.id
      WHERE w.id = ?
    `).get(id);

    return workflow ? this._formatWorkflow(workflow) : null;
  }

  // Find all workflows
  findAll({ page = 1, limit = 50, enabled, trigger_type } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (enabled !== undefined) {
      conditions.push("w.enabled = ?");
      params.push(enabled ? 1 : 0);
    }
    if (trigger_type) {
      conditions.push("w.trigger_type = ?");
      params.push(trigger_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db.prepare(`SELECT COUNT(*) as count FROM workflows w ${where}`).get(...params).count;

    const workflows = db.prepare(`
      SELECT w.*, u.username as created_by_username,
        (SELECT COUNT(*) FROM workflow_executions WHERE workflow_id = w.id) as execution_count,
        (SELECT COUNT(*) FROM workflow_executions WHERE workflow_id = w.id AND status = 'completed') as success_count
      FROM workflows w
      LEFT JOIN users u ON w.created_by = u.id
      ${where}
      ORDER BY w.name ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: workflows.map(this._formatWorkflow),
      pagination: { page, limit, total },
    };
  }

  // Update workflow
  update(id, data, _userId) {
    const db = getDb();
    const existing = this.findById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Workflow not found" };
    }

    const updates = [];
    const params = [];

    if (data.name !== undefined) {
      updates.push("name = ?");
      params.push(data.name);
    }
    if (data.description !== undefined) {
      updates.push("description = ?");
      params.push(data.description);
    }
    if (data.trigger_type !== undefined) {
      updates.push("trigger_type = ?");
      params.push(data.trigger_type);
    }
    if (data.trigger_config !== undefined) {
      updates.push("trigger_config = ?");
      params.push(JSON.stringify(data.trigger_config));
    }
    if (data.steps !== undefined) {
      updates.push("steps = ?");
      params.push(JSON.stringify(data.steps));
    }
    if (data.variables !== undefined) {
      updates.push("variables = ?");
      params.push(JSON.stringify(data.variables));
    }
    if (data.enabled !== undefined) {
      updates.push("enabled = ?");
      params.push(data.enabled ? 1 : 0);
    }
    if (data.timeout_seconds !== undefined) {
      updates.push("timeout_seconds = ?");
      params.push(data.timeout_seconds);
    }

    if (updates.length === 0) {
      return { data: existing };
    }

    updates.push("updated_at = datetime('now')");
    params.push(id);

    try {
      db.prepare(`UPDATE workflows SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      return { data: this.findById(id), oldValue: existing };
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "CONFLICT", message: "Workflow name already exists" };
      }
      throw err;
    }
  }

  // Delete workflow
  delete(id) {
    const db = getDb();
    const existing = this.findById(id);

    if (!existing) {
      return { error: "NOT_FOUND", message: "Workflow not found" };
    }

    db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    webhookService.trigger("workflow.deleted", { workflow: existing });
    return { data: existing };
  }

  // Execute a workflow
  async execute(workflowId, { variables = {}, trigger_type = "manual", trigger_data = {} } = {}, userId) {
    const db = getDb();
    const workflow = this.findById(workflowId);

    if (!workflow) {
      return { error: "NOT_FOUND", message: "Workflow not found" };
    }

    if (!workflow.enabled) {
      return { error: "DISABLED", message: "Workflow is disabled" };
    }

    // Merge variables
    const mergedVariables = { ...workflow.variables, ...variables };

    // Create execution record
    const result = db.prepare(`
      INSERT INTO workflow_executions (workflow_id, status, trigger_type, trigger_data, variables, created_by, started_at)
      VALUES (?, 'running', ?, ?, ?, ?, datetime('now'))
    `).run(workflowId, trigger_type, JSON.stringify(trigger_data), JSON.stringify(mergedVariables), userId);

    const executionId = result.lastInsertRowid;

    // Track running workflow
    this.runningWorkflows.set(executionId, { workflowId, startTime: Date.now() });

    // Execute steps asynchronously
    this._executeSteps(executionId, workflow, mergedVariables);

    return { data: { executionId, status: "running" } };
  }

  // Execute workflow steps
  async _executeSteps(executionId, workflow, variables) {
    const db = getDb();
    const steps = workflow.steps;
    const stepResults = [];
    const currentVars = { ...variables };

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Update current step
        db.prepare("UPDATE workflow_executions SET current_step = ? WHERE id = ?").run(i, executionId);

        // Log step start
        const stepLogId = db.prepare(`
          INSERT INTO workflow_step_logs (execution_id, step_index, step_name, status, input, started_at)
          VALUES (?, ?, ?, 'running', ?, datetime('now'))
        `).run(executionId, i, step.name || `Step ${i + 1}`, JSON.stringify(step)).lastInsertRowid;

        websocketService.broadcast(`workflow:${executionId}`, {
          type: "step_started",
          step: i,
          stepName: step.name,
        });

        const startTime = Date.now();
        let stepResult;

        try {
          stepResult = await this._executeStep(step, currentVars, executionId);

          // Update variables with step output
          if (stepResult.output && step.outputVariable) {
            currentVars[step.outputVariable] = stepResult.output;
          }

          stepResults.push({ step: i, status: "completed", output: stepResult.output });

          db.prepare(`
            UPDATE workflow_step_logs
            SET status = 'completed', output = ?, duration_ms = ?, completed_at = datetime('now')
            WHERE id = ?
          `).run(JSON.stringify(stepResult.output), Date.now() - startTime, stepLogId);

        } catch (stepErr) {
          stepResults.push({ step: i, status: "failed", error: stepErr.message });

          db.prepare(`
            UPDATE workflow_step_logs
            SET status = 'failed', error = ?, duration_ms = ?, completed_at = datetime('now')
            WHERE id = ?
          `).run(stepErr.message, Date.now() - startTime, stepLogId);

          // Check if we should continue on error
          if (!step.continueOnError) {
            throw stepErr;
          }
        }
      }

      // Workflow completed successfully
      db.prepare(`
        UPDATE workflow_executions
        SET status = 'completed', step_results = ?, variables = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(stepResults), JSON.stringify(currentVars), executionId);

      websocketService.broadcast(`workflow:${executionId}`, {
        type: "completed",
        status: "completed",
      });

      webhookService.trigger("workflow.completed", {
        executionId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: "completed",
      });

    } catch (err) {
      db.prepare(`
        UPDATE workflow_executions
        SET status = 'failed', step_results = ?, error_message = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(stepResults), err.message, executionId);

      websocketService.broadcast(`workflow:${executionId}`, {
        type: "failed",
        error: err.message,
      });

      webhookService.trigger("workflow.failed", {
        executionId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        error: err.message,
      });
    } finally {
      this.runningWorkflows.delete(executionId);
    }
  }

  // Execute a single step
  async _executeStep(step, variables, _executionId) {
    switch (step.type) {
      case "command":
        return this._executeCommandStep(step, variables);
      case "wait":
        return this._executeWaitStep(step);
      case "condition":
        return this._executeConditionStep(step, variables);
      case "parallel":
        return this._executeParallelStep(step, variables);
      case "notify":
        return this._executeNotifyStep(step, variables);
      case "http":
        return this._executeHttpStep(step, variables);
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  _executeCommandStep(step, variables) {
    const agentId = this._interpolate(step.agentId, variables);
    const command = step.command;
    const payload = this._interpolateObject(step.payload || {}, variables);

    const result = agentControlService.sendCommand(agentId, command, payload, null);

    if (result.error) {
      throw new Error(result.message);
    }

    return { output: result.data };
  }

  async _executeWaitStep(step) {
    const seconds = step.seconds || 1;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { output: { waited: seconds } };
  }

  _executeConditionStep(step, variables) {
    const condition = this._interpolate(step.condition, variables);
    // Simple condition evaluation
    const result = this._evaluateCondition(condition, variables);
    return { output: { result, condition } };
  }

  async _executeParallelStep(step, variables) {
    const subSteps = step.steps || [];
    const results = await Promise.all(
      subSteps.map((subStep) => this._executeStep(subStep, variables, null))
    );
    return { output: results };
  }

  _executeNotifyStep(step, variables) {
    const message = this._interpolate(step.message, variables);
    const channel = step.channel || "webhook";

    websocketService.broadcast("notifications", {
      type: "workflow_notification",
      message,
      channel,
    });

    return { output: { notified: true, message } };
  }

  async _executeHttpStep(step, variables) {
    const url = this._interpolate(step.url, variables);
    const method = step.method || "GET";

    // In production, would use headers and body from step config
    // const headers = this._interpolateObject(step.headers || {}, variables);
    // const body = step.body ? this._interpolateObject(step.body, variables) : undefined;

    return { output: { url, method, status: "simulated" } };
  }

  // Cancel a running execution
  cancel(executionId) {
    const db = getDb();
    const execution = this.getExecution(executionId);

    if (!execution) {
      return { error: "NOT_FOUND", message: "Execution not found" };
    }

    if (execution.status !== "running" && execution.status !== "pending") {
      return { error: "INVALID_STATE", message: `Cannot cancel ${execution.status} execution` };
    }

    db.prepare(`
      UPDATE workflow_executions
      SET status = 'cancelled', completed_at = datetime('now')
      WHERE id = ?
    `).run(executionId);

    this.runningWorkflows.delete(executionId);

    websocketService.broadcast(`workflow:${executionId}`, {
      type: "cancelled",
    });

    return { data: { executionId, cancelled: true } };
  }

  // Get execution details
  getExecution(executionId) {
    const db = getDb();
    const execution = db.prepare(`
      SELECT e.*, w.name as workflow_name, u.username as created_by_username
      FROM workflow_executions e
      JOIN workflows w ON e.workflow_id = w.id
      LEFT JOIN users u ON e.created_by = u.id
      WHERE e.id = ?
    `).get(executionId);

    return execution ? this._formatExecution(execution) : null;
  }

  // Get executions for a workflow
  getExecutions(workflowId, { page = 1, limit = 20, status } = {}) {
    const db = getDb();
    const offset = (page - 1) * limit;
    const conditions = ["e.workflow_id = ?"];
    const params = [workflowId];

    if (status) {
      conditions.push("e.status = ?");
      params.push(status);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const total = db.prepare(`SELECT COUNT(*) as count FROM workflow_executions e ${where}`).get(...params).count;

    const executions = db.prepare(`
      SELECT e.*, u.username as created_by_username
      FROM workflow_executions e
      LEFT JOIN users u ON e.created_by = u.id
      ${where}
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return {
      data: executions.map(this._formatExecution),
      pagination: { page, limit, total },
    };
  }

  // Get step logs for an execution
  getStepLogs(executionId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM workflow_step_logs
      WHERE execution_id = ?
      ORDER BY step_index
    `).all(executionId).map((log) => ({
      id: log.id,
      stepIndex: log.step_index,
      stepName: log.step_name,
      status: log.status,
      input: JSON.parse(log.input || "{}"),
      output: JSON.parse(log.output || "null"),
      error: log.error,
      durationMs: log.duration_ms,
      startedAt: log.started_at,
      completedAt: log.completed_at,
    }));
  }

  // Helper: Interpolate variables in string
  _interpolate(str, variables) {
    if (typeof str !== "string") return str;
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || "");
  }

  // Helper: Interpolate variables in object
  _interpolateObject(obj, variables) {
    if (typeof obj === "string") {
      return this._interpolate(obj, variables);
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this._interpolateObject(item, variables));
    }
    if (typeof obj === "object" && obj !== null) {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this._interpolateObject(value, variables);
      }
      return result;
    }
    return obj;
  }

  // Helper: Evaluate simple condition
  _evaluateCondition(condition, variables) {
    // Simple equality check: "variable == value"
    const match = condition.match(/^(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)$/);
    if (!match) return false;

    const [, varName, operator, value] = match;
    const leftValue = variables[varName];
    const rightValue = value.replace(/^["']|["']$/g, "");

    switch (operator) {
      case "==": return String(leftValue) === rightValue;
      case "!=": return String(leftValue) !== rightValue;
      case ">": return Number(leftValue) > Number(rightValue);
      case "<": return Number(leftValue) < Number(rightValue);
      case ">=": return Number(leftValue) >= Number(rightValue);
      case "<=": return Number(leftValue) <= Number(rightValue);
      default: return false;
    }
  }

  _formatWorkflow(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      triggerType: row.trigger_type,
      triggerConfig: JSON.parse(row.trigger_config || "{}"),
      steps: JSON.parse(row.steps || "[]"),
      variables: JSON.parse(row.variables || "{}"),
      enabled: Boolean(row.enabled),
      timeoutSeconds: row.timeout_seconds,
      retryOnFailure: Boolean(row.retry_on_failure),
      maxRetries: row.max_retries,
      executionCount: row.execution_count || 0,
      successCount: row.success_count || 0,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _formatExecution(row) {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      status: row.status,
      triggerType: row.trigger_type,
      triggerData: JSON.parse(row.trigger_data || "{}"),
      variables: JSON.parse(row.variables || "{}"),
      currentStep: row.current_step,
      stepResults: JSON.parse(row.step_results || "[]"),
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdBy: row.created_by,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
    };
  }
}

module.exports = new WorkflowService();
