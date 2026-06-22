/**
 * src/routes/taskRoutes.js
 *
 * GET    /api/tasks?requirement_id=&status=&assignee_id=
 * POST   /api/tasks                           pm only
 * GET    /api/tasks/:id
 * PATCH  /api/tasks/:id                       pm, member
 * PATCH  /api/tasks/:id/status                all authenticated
 * DELETE /api/tasks/:id                       pm only
 *
 * GET    /api/tasks/dependencies?task_id=     (top-level, requires query param)
 * GET    /api/tasks/:id/dependencies
 * POST   /api/tasks/dependencies              pm only (DFS check inside)
 * DELETE /api/tasks/dependencies/:task_id/:depends_on_task_id  pm only
 */

import express from "express";
const router = express.Router();
import { z } from "zod";
import validate from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

import {
  listTasks,
  createTask,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  listDependencies,
  addDependency,
  removeDependency,
} from "../controllers/taskController.js";

// ─── Validation schemas ───────────────────────────────────────────────────────

const CreateTaskSchema = z.object({
  requirement_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  assignee_id: z.string().uuid().optional().nullable(),
  estimated_hours: z.number().int().min(0).max(999).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  assignee_id: z.string().uuid().optional().nullable(),
  estimated_hours: z.number().int().min(0).max(999).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  is_at_risk: z.boolean().optional(),
});

const UpdateStatusSchema = z.object({
  status: z.enum(["BLOCKED", "TO_DO", "IN_PROGRESS", "DONE", "CANCELLED"]),
});

const AddDependencySchema = z.object({
  task_id: z.string().uuid(),
  depends_on_task_id: z.string().uuid(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.use(requireAuth);

// IMPORTANT: static paths (/dependencies) must come BEFORE dynamic (/:id) to
// avoid Express matching "dependencies" as a task ID.
router.get("/dependencies", listDependencies); // uses ?task_id= query param
router.post(
  "/dependencies",
  requireRole("pm"),
  validate(AddDependencySchema),
  addDependency,
);
router.delete(
  "/dependencies/:task_id/:depends_on_task_id",
  requireRole("pm"),
  removeDependency,
);

router.get("/", listTasks);
router.post("/", requireRole("pm"), validate(CreateTaskSchema), createTask);

router.get("/:id", getTask);
router.patch(
  "/:id",
  requireRole("pm", "member"), // "member" matches the DB role enum
  validate(UpdateTaskSchema),
  updateTask,
);
router.patch("/:id/status", validate(UpdateStatusSchema), updateTaskStatus);
router.delete("/:id", requireRole("pm"), deleteTask);

router.get("/:id/dependencies", listDependencies); // uses req.params.id

export default router;
