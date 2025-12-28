const express = require("express");
const workflowService = require("../../services/workflow.service");
const auditService = require("../../services/audit.service");
const send = require("../../utils/response");
const { authenticate } = require("../../middleware/auth");
const { z } = require("zod");

const router = express.Router();

// Validation schema
const WorkflowStepSchema = z.object({
  type: z.enum(["command", "wait", "condition", "parallel", "notify", "http"]),
  name: z.string().optional(),
  agentId: z.string().optional(),
  command: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  seconds: z.number().optional(),
  condition: z.string().optional(),
  steps: z.array(z.lazy(() => WorkflowStepSchema)).optional(),
  message: z.string().optional(),
  channel: z.string().optional(),
  url: z.string().optional(),
  method: z.string().optional(),
  headers: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
  outputVariable: z.string().optional(),
  continueOnError: z.boolean().optional(),
});

const WorkflowSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  trigger_type: z.enum(["manual", "schedule", "event", "webhook"]).optional().default("manual"),
  trigger_config: z.record(z.unknown()).optional().default({}),
  steps: z.array(WorkflowStepSchema).min(1),
  variables: z.record(z.unknown()).optional().default({}),
  timeout_seconds: z.number().min(1).max(86400).optional().default(3600),
  retry_on_failure: z.boolean().optional().default(false),
  max_retries: z.number().min(1).max(10).optional().default(3),
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

// List all workflows
router.get("/", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const enabled = req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
    const { trigger_type } = req.query;

    const result = workflowService.findAll({ page, limit, enabled, trigger_type });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get workflow by ID
router.get("/:id", authenticate, (req, res) => {
  try {
    const workflow = workflowService.findById(parseInt(req.params.id));
    if (!workflow) {
      return send.notFound(res, "Workflow not found");
    }
    send.ok(res, workflow);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Create a workflow
router.post("/", authenticate, validate(WorkflowSchema), (req, res) => {
  try {
    const result = workflowService.create(req.validated, req.user.id);

    if (result.error) {
      if (result.error === "CONFLICT") {
        return send.conflict(res, result.message);
      }
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "create",
      resourceType: "workflow",
      resourceId: result.data.id.toString(),
      newValue: { name: result.data.name, steps: result.data.steps.length },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.created(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Update a workflow
router.put("/:id", authenticate, (req, res) => {
  try {
    const result = workflowService.update(parseInt(req.params.id), req.body, req.user.id);

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }
    if (result.error === "CONFLICT") {
      return send.conflict(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "update",
      resourceType: "workflow",
      resourceId: req.params.id,
      oldValue: result.oldValue,
      newValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Delete a workflow
router.delete("/:id", authenticate, (req, res) => {
  try {
    const result = workflowService.delete(parseInt(req.params.id));

    if (result.error === "NOT_FOUND") {
      return send.notFound(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "delete",
      resourceType: "workflow",
      resourceId: req.params.id,
      oldValue: result.data,
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, { deleted: true });
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Execute a workflow
router.post("/:id/execute", authenticate, async (req, res) => {
  try {
    const { variables = {}, trigger_data = {} } = req.body;

    const result = await workflowService.execute(
      parseInt(req.params.id),
      { variables, trigger_type: "manual", trigger_data },
      req.user.id
    );

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.bad(res, result.message);
    }

    auditService.log({
      userId: req.user.id,
      action: "execute",
      resourceType: "workflow",
      resourceId: req.params.id,
      newValue: { executionId: result.data.executionId },
      ipAddress: req.ip,
      requestId: req.id,
    });

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get workflow executions
router.get("/:id/executions", authenticate, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { status } = req.query;

    const result = workflowService.getExecutions(parseInt(req.params.id), { page, limit, status });
    send.paginated(res, result.data, result.pagination);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get execution details
router.get("/executions/:executionId", authenticate, (req, res) => {
  try {
    const execution = workflowService.getExecution(parseInt(req.params.executionId));
    if (!execution) {
      return send.notFound(res, "Execution not found");
    }
    send.ok(res, execution);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Get step logs for an execution
router.get("/executions/:executionId/logs", authenticate, (req, res) => {
  try {
    const logs = workflowService.getStepLogs(parseInt(req.params.executionId));
    send.ok(res, logs);
  } catch (err) {
    send.serverErr(res, err);
  }
});

// Cancel an execution
router.post("/executions/:executionId/cancel", authenticate, (req, res) => {
  try {
    const result = workflowService.cancel(parseInt(req.params.executionId));

    if (result.error) {
      if (result.error === "NOT_FOUND") {
        return send.notFound(res, result.message);
      }
      return send.bad(res, result.message);
    }

    send.ok(res, result.data);
  } catch (err) {
    send.serverErr(res, err);
  }
});

module.exports = router;
