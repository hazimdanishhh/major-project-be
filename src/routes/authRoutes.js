/**
 * src/routes/authRoutes.js
 *
 * POST /api/auth/register  — create a CLIENT user + profile (open, client-only)
 * POST /api/auth/team      — create a PM or MEMBER user + profile (pm-only)
 * GET  /api/auth/me        — return current user (authenticated)
 * GET  /api/auth/users     — list all users for dropdowns (pm + member)
 *
 * The very first pm account (before any pm exists to use /team) is created
 * via scripts/manageAccount.js — see major-project-implementation-guide/
 * PROCESS_FLOW.md's Onboarding section.
 */

import express from "express";
const router = express.Router();
import { z } from "zod";
import validate from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimiter.js";
import {
  register,
  me,
  listUsers,
  createTeamMember,
} from "../controllers/authController.js";

// Shared between RegisterSchema and CreateTeamMemberSchema so the password/
// name policy can't drift between the two account-creation paths.
const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address")
  .max(254);

const PasswordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(72, "Password must be at most 72 characters")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a special character");

const FullNameSchema = z
  .string()
  .trim()
  .min(2, "Full name must be at least 2 characters")
  .max(100, "Full name must be at most 100 characters")
  .regex(
    /^[\p{L}][\p{L} '.-]*$/u,
    "Full name can only contain letters, spaces, apostrophes, and hyphens",
  );

// No `role` field — this endpoint only ever creates client accounts (see
// authController.register). Any extra `role` key sent in the body is
// silently stripped by Zod rather than honored.
const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  full_name: FullNameSchema,
});

// No `password` field — the backend generates one (see
// authController.createTeamMember) rather than having the pm choose
// another person's login credential. `role` is restricted to pm/member —
// clients always self-register via /register, never via this endpoint.
const CreateTeamMemberSchema = z.object({
  email: EmailSchema,
  full_name: FullNameSchema,
  role: z.enum(["pm", "member"]),
});

// Public
router.post("/register", authLimiter, validate(RegisterSchema), register);

// Protected
router.get("/me", requireAuth, me);
router.get("/users", requireAuth, requireRole("pm", "member"), listUsers);
router.post(
  "/team",
  requireAuth,
  requireRole("pm"),
  validate(CreateTeamMemberSchema),
  createTeamMember,
);

export default router;
