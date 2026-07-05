/**
 * src/routes/requirementRoutes.js
 *
 * GET    /api/requirements?project_id=
 * POST   /api/requirements
 * GET    /api/requirements/:id
 * PATCH  /api/requirements/:id
 * DELETE /api/requirements/:id          pm only
 *
 * GET    /api/requirements/:id/versions
 * GET    /api/requirements/:id/history
 *
 * POST   /api/requirements/:id/specs
 * PATCH  /api/requirements/:id/specs/:spec_id
 *
 */

import express from "express";
const router = express.Router();
import { z } from "zod";
import validate from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

import {
  listRequirements,
  createRequirement,
  getRequirement,
  updateRequirement,
  deleteRequirement,
  getVersions,
  getStatusHistory,
  createSpec,
  updateSpec,
} from "../controllers/requirementController.js";

// ─── Validation schemas ───────────────────────────────────────────────────────

const CreateRequirementSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
});

const UpdateRequirementSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  new_status: z
    .enum([
      "DRAFT",
      "SUBMITTED",
      "UNDER_ANALYSIS",
      "SPECIFICATION_DRAFTED",
      "CLIENT_VALIDATION",
      "APPROVED",
      "IMPLEMENTATION",
      "COMPLETED",
    ])
    .optional(),
});

// status is system-managed (see updateRequirement's spec auto-sync) —
// not a client-settable field.
const SpecSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().min(1),
  acceptance_criteria: z.string().optional(),
  complexity_score: z.number().int().min(0).max(10).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.use(requireAuth);

router.get("/", listRequirements);
router.post(
  "/",
  requireRole("pm", "client"),
  validate(CreateRequirementSchema),
  createRequirement,
);

router.get("/:id", getRequirement);
router.patch(
  "/:id",
  requireRole("pm", "client"),
  validate(UpdateRequirementSchema),
  updateRequirement,
);
router.delete("/:id", requireRole("pm"), deleteRequirement);

// Version & history
router.get("/:id/versions", getVersions);
router.get("/:id/history", getStatusHistory);

// Specifications
router.post("/:id/specs", requireRole("pm"), validate(SpecSchema), createSpec);
router.patch(
  "/:id/specs/:spec_id",
  requireRole("pm"),
  validate(SpecSchema.partial()),
  updateSpec,
);

export default router;
