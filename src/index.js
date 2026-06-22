/**
 * src/index.js
 *
 * Express application entry point.
 *
 * Startup order:
 *   1. Load .env
 *   2. Validate required env vars
 *   3. Apply global middleware (security, CORS, logging, rate limiting)
 *   4. Mount API routers
 *   5. Error handling (404 + global error handler)
 *   6. Start HTTP server
 */

import "dotenv/config";

// ─── Env validation ───────────────────────────────────────────────────────────
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "GROQ_API_KEY"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `[Startup] Missing required environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { generalLimiter } from "./middleware/rateLimiter.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

// ─── Routers ──────────────────────────────────────────────────────────────────
import authRoutes from "./routes/authRoutes.js";
import projectRoutes from "./routes/projectRoutes.js";
import requirementRoutes from "./routes/requirementRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import traceabilityRoutes from "./routes/traceabilityRoutes.js";

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use(helmet());

// CORS — allow only the configured frontend origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (Postman, server-to-server) when no origin is sent
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS policy: Origin '${origin}' is not allowed.`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// HTTP logging (skip in test environment)
if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
}

// Body parsing
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiter
app.use(generalLimiter);

// ─── Health check (no auth — for uptime pings) ────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/requirements", requirementRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/traceability", traceabilityRoutes);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "4000", 10);

app.listen(PORT, () => {
  console.log(
    `[Server] Running on port ${PORT} in ${process.env.NODE_ENV || "development"} mode`,
  );
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
  console.log(
    `[Server] Allowed origins: ${allowedOrigins.join(", ") || "(none configured)"}`,
  );
});

export default app; // exported for testing
