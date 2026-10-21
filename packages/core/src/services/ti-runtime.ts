import type { ChatTurn } from "./chat-endpoint";

export type TiToolCall = ChatTurn["toolCalls"][number];
export type TiRuntimeErrorCode = "cancelled" | "deadline" | "round_limit" | "tool_limit" | "context_limit" | "invalid_response";

export class TiRuntimeError extends Error {
  constructor(readonly code: TiRuntimeErrorCode) {
    super(`Ti execution stopped: ${code}`);
    this.name = "TiRuntimeError";
  }
}

export interface TiRuntimeOptions {
  messages: Record<string, unknown>[];
  deadline: number;
  signal?: AbortSignal;
  maxRounds?: number;
  maxToolCalls?: number;
  maxContextBytes?: number;
  /** Supervisors must recheck live authority and, for tasks, the attempt lease. */
  authorize(): Promise<void>;
  requestTurn(input: { round: number; messages: Record<string, unknown>[]; finalRound: boolean }): Promise<ChatTurn>;
  executeTool(call: TiToolCall): Promise<string>;
  /** Interactive supervisors can stop after recording confirmation proposals. */
  afterTools?(): Promise<string | undefined>;
}

/** Shared bounded model/tool loop. Identity, approvals and durable state belong to supervisors. */
export async function runTiRuntime(options: TiRuntimeOptions): Promise<string> {
  const maxRounds = options.maxRounds ?? 16;
  const maxToolCalls = options.maxToolCalls ?? 200;
  const maxContextBytes = options.maxContextBytes ?? 1_048_576;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || !Number.isInteger(maxToolCalls) || maxToolCalls < 0
    || !Number.isInteger(maxContextBytes) || maxContextBytes < 1 || !Number.isFinite(options.deadline)) {
    throw new RangeError("Invalid Ti runtime limits");
  }
  let toolCalls = 0;
  const guard = () => {
    if (options.signal?.aborted) throw new TiRuntimeError("cancelled");
    if (performance.now() >= options.deadline) throw new TiRuntimeError("deadline");
  };
  const authorize = async () => { guard(); await options.authorize(); guard(); };
  for (let round = 0; round < maxRounds; round++) {
    await authorize();
    if (Buffer.byteLength(JSON.stringify(options.messages), "utf8") > maxContextBytes) throw new TiRuntimeError("context_limit");
    const finalRound = round === maxRounds - 1;
    const turn = await options.requestTurn({ round, messages: options.messages, finalRound });
    await authorize();
    if (!turn.toolCalls.length) {
      if (!turn.content || turn.content.includes("<｜DSML｜")) throw new TiRuntimeError("invalid_response");
      return turn.content;
    }
    if (finalRound) throw new TiRuntimeError("round_limit");
    if (toolCalls + turn.toolCalls.length > maxToolCalls) throw new TiRuntimeError("tool_limit");
    options.messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls.map(call => ({
      id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
    })) });
    for (const call of turn.toolCalls) {
      await authorize();
      toolCalls++;
      const content = await options.executeTool(call);
      await authorize();
      options.messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    const stopped = await options.afterTools?.();
    await authorize();
    if (stopped !== undefined) return stopped;
  }
  throw new TiRuntimeError("round_limit");
}
