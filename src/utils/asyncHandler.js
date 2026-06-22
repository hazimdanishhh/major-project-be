/**
 * src/utils/asyncHandler.js
 *
 * Wraps an async express handler so unhandled promise rejections
 * are automatically forwarded to next(err) — the global error handler.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }))
 *
 * Note: The controllers already use try/catch + next(err) for clarity,
 * but this utility is available for simpler handlers.
 */

export default function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
