/**
 * src/middleware/errorHandler.js
 *
 * Two middlewares:
 *   notFound      — catches requests to undefined routes (404)
 *   errorHandler  — handles all errors thrown or passed to next(err)
 *
 * Register notFound AFTER all routes.
 * Register errorHandler LAST (must have 4 params: err, req, res, next).
 */

import { ZodError } from "zod";

/**
 * 404 — route not matched by any router
 */
export function notFound(req, res, next) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

/**
 * Global error handler.
 * Recognises:
 *   - ZodError  → 400 Validation Error with per-field details
 *   - Explicit statusCode on error object → uses it
 *   - Everything else → 500 Internal Server Error
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation error",
      details: err.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  }

  const status = err.statusCode || err.status || 500;
  const message = err.message || "Internal server error";

  if (process.env.NODE_ENV !== "production") {
    console.error("[Error]", err);
  }

  res.status(status).json({ error: message });
}
