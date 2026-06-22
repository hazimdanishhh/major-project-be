/**
 * src/routes/authRoutes.js
 *
 * POST /api/auth/register  — create user + profile (open)
 * GET  /api/auth/me        — return current user (authenticated)
 * GET  /api/auth/users     — list all users for dropdowns (pm + member)
 */

import express from "express";
const router = express.Router();
import { z } from "zod";
import validate from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import { register, me, listUsers } from "../controllers/authController.js";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().min(1).max(100),
  role: z.enum(["client", "pm", "member"]),
});

// Public
router.post("/register", authLimiter, validate(RegisterSchema), register);

// Protected
router.get("/me", requireAuth, me);
router.get("/users", requireAuth, requireRole("pm", "member"), listUsers);

export default router;
