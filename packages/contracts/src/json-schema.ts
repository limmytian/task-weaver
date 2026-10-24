import { z } from "zod";

/** Describe transport inputs rather than parsed defaults or transformed outputs. */
export function inputJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: ({ zodSchema }) => {
      if (zodSchema instanceof z.ZodDate) return { type: "string", format: "date-time" };
      return "throw";
    },
  });
}
