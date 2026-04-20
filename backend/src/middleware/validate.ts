import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodSchema } from "zod";

type Target = "body" | "query" | "params";

export function validate(
  schema: ZodSchema,
  target: Target = "body",
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        details: result.error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
      return;
    }
    (req as Request)[target] = result.data as never;
    next();
  };
}
