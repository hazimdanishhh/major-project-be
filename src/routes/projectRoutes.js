/**
 * src/routes/projectRoutes.js
 *
 * All routes require authentication.
 *
 * Visibility: pm sees projects where pm_id = them; client sees projects where
 * client_id = them; member sees projects where they're assigned a task.
 *
 * GET    /api/projects
 * POST   /api/projects              pm only
 * GET    /api/projects/:id
 * PATCH  /api/projects/:id          pm only
 * DELETE /api/projects/:id          pm only
 * GET    /api/projects/:id/critical-path
 * POST   /api/projects/:id/generate-wbs   pm only, AI-rate-limited
 * POST   /api/projects/:id/persist-wbs    pm only
 */

import express from "express";
const router = express.Router();
import { z } from "zod";
import validate from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listProjectsPaginated,
} from "../controllers/projectController.js";
import { criticalPath } from "../controllers/algorithmController.js";
import { aiLimiter } from "../middleware/rateLimiter.js";
import { generateWBSPreview, persistWBS } from "../controllers/aiController.js";

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  client_id: z.string().uuid(),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  status: z.enum(["ACTIVE", "ON_HOLD", "COMPLETED", "ARCHIVED"]).optional(),
  client_id: z.string().uuid().optional(),
});

const ListProjectsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().max(200).optional(),
    sortBy: z.enum(["name", "status", "created_at"]).default("created_at"),
    sortOrder: z.enum(["ascending", "descending"]).default("descending"),
  })
  .passthrough(); // lets ?status=ACTIVE-style dynamic filters keep flowing through

const PersistGlobalWBSSchema = z.object({
  tasks: z
    .array(
      z.object({
        temp_id: z.string(),
        requirement_id: z.string().uuid(),
        title: z.string().min(1),
        description: z.string().optional(),
        assignee_id: z.string().uuid().optional().nullable(),
        estimated_hours: z.number().int().min(0).optional(),
        priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
        depends_on_temp_ids: z.array(z.string()).optional(),
        depends_on_existing_task_ids: z.array(z.string().uuid()).optional(),
        is_ai_generated: z.boolean().optional(),
      }),
    )
    .min(1),
});

router.use(requireAuth);

router.get("/", validate(ListProjectsQuerySchema, "query"), listProjectsPaginated);
router.post(
  "/",
  requireRole("pm"),
  validate(CreateProjectSchema),
  createProject,
);

router.get("/:id", getProject);
router.patch(
  "/:id",
  requireRole("pm"),
  validate(UpdateProjectSchema),
  updateProject,
);
router.delete("/:id", requireRole("pm"), deleteProject);

// Global AI WBS Generation
router.post(
  "/:id/generate-wbs",
  requireRole("pm"),
  aiLimiter,
  generateWBSPreview,
);

router.post(
  "/:id/persist-wbs",
  requireRole("pm"),
  validate(PersistGlobalWBSSchema),
  persistWBS,
);

// CPM — available to all authenticated roles
router.get("/:id/critical-path", criticalPath);

export default router;
