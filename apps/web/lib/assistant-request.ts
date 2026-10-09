/** Only query the original request after a transport failure; never resubmit writes. */
export function canRecoverAssistantRequest(error: unknown) {
  const status = (error as { data?: { httpStatus?: number } } | null)?.data?.httpStatus;
  return status === undefined || status === 409 || status >= 500;
}

export async function recoverAssistantRequest<T>(
  lookup: () => Promise<{ status: string; result: T | null }>,
  wait: () => Promise<void>,
  attempts = 220,
): Promise<T | null> {
  let missing = 0;
  let transportFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await lookup();
      transportFailures = 0;
      missing = response.status === "not_found" ? missing + 1 : 0;
      if (missing >= 10) return null;
      if (response.status === "failed") return null;
      if (response.status === "completed") return response.result;
    } catch (error) {
      if (!canRecoverAssistantRequest(error) || ++transportFailures >= 3) return null;
    }
    if (attempt + 1 < attempts) await wait();
  }
  return null;
}
