/**
 * src/routes/traceabilityRoutes.js
 *
 * GET /api/traceability?project_id=  — Requirements Traceability Matrix (RTM)
 *
 * Backed by the `traceability_matrix` view in Supabase.
 * Rows with is_at_risk=true indicate a "Suspect Link" per Section 7.
 */

import express from "express";
const router = express.Router();
import { requireAuth } from "../middleware/auth.js";
import { traceabilityMatrix } from "../controllers/algorithmController.js";

router.use(requireAuth);

router.get("/", traceabilityMatrix);

export default router;
