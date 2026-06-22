/**
 * src/middleware/rateLimiter.js
 *
 * Two limiters:
 *   generalLimiter  — applied globally (100 req / 15 min per IP)
 *   authLimiter     — tighter limit on auth endpoints (20 req / 15 min per IP)
 *   aiLimiter       — very tight limit on AI endpoints (10 req / hour per IP)
 *                     guards against runaway Groq API spend
 */

import rateLimit from "express-rate-limit";

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in 15 minutes." },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Please try again in 15 minutes." },
});

export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "AI generation limit reached. Please try again in 1 hour.",
  },
});
