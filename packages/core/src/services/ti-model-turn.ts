import type { ChatProxySettings } from "@task-weaver/contracts";
import { requestChatTurn } from "./chat-endpoint";

export interface TiUsageCollector {
  observe(value: unknown, actualModel?: unknown): void;
  finish(outcome: "succeeded" | "failed" | "cancelled"): Promise<void>;
}

/** Shared transport and usage lifecycle; credentials never enter the model messages. */
export async function requestTiModelTurn(input: {
  baseUrl: string;
  apiKey: string;
  payload: Record<string, unknown>;
  deadline: number;
  signal?: AbortSignal;
  proxy?: ChatProxySettings;
  onText?: (text: string) => Promise<void>;
  beginUsage(): Promise<TiUsageCollector>;
}) {
  let collector: TiUsageCollector | undefined;
  try {
    const turn = await requestChatTurn(input.baseUrl, input.apiKey, input.payload, input.deadline,
      input.onText, false, input.proxy, {
        async start() { collector = await input.beginUsage(); },
        observe(value, model) { collector?.observe(value, model); },
      }, input.signal);
    await collector?.finish("succeeded");
    return turn;
  } catch (error) {
    await collector?.finish(input.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failed");
    throw error;
  }
}
