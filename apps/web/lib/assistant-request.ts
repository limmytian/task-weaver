/** Only query the original request after a transport failure; never resubmit writes. */
export function canRecoverAssistantRequest(error: unknown) {
  const status = (error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;
  return status === undefined || status >= 500;
}

export async function recoverAssistantRequest<T>(
  lookup: () => Promise<{ status: string; result: T | null }>,
  wait: () => Promise<void>,
  attempts = 50,
): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await lookup();
      if (response.status === "failed") return null;
      if (response.status === "completed") return response.result;
    } catch (error) {
      if (!canRecoverAssistantRequest(error)) return null;
    }
    if (attempt + 1 < attempts) await wait();
  }
  return null;
}
