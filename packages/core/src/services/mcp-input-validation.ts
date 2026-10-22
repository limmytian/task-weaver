import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { ValidationError } from "@task-weaver/contracts";

export class McpInputValidationError extends ValidationError {
  constructor() { super("MCP arguments do not match the current input schema; no external call was dispatched"); }
}

/** A new compiler per schema prevents one server's $id from reusing another server's validator. */
export function requireMcpInput(schema: unknown, args: Record<string, unknown> | undefined) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || Buffer.byteLength(JSON.stringify(schema)) > 65_536) throw new McpInputValidationError();
  try {
    const validator = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType);
    if (!validator(args ?? {}).valid) throw new McpInputValidationError();
  } catch { throw new McpInputValidationError(); }
}
