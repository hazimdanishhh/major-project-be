/**
 * src/middleware/validate.js
 *
 * Generic Zod validation middleware factory.
 * Pass a Zod schema and which part of the request to validate.
 *
 * Usage:
 *   router.post('/', validate(MySchema, 'body'), handler)
 *   router.get('/',  validate(QuerySchema, 'query'), handler)
 */

import { ZodError } from "zod";

/**
 * @param {import('zod').ZodSchema} schema
 * @param {'body' | 'query' | 'params'} source
 */
export default function validate(schema, source = "body") {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed; // replace with coerced/typed data
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: "Validation error",
          details: err.errors.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }
      next(err);
    }
  };
}
