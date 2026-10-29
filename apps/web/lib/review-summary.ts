export const REVIEW_SUMMARY_PREVIEW_LIMIT = 4_000;

export function reviewRunText(status: string, outputSummary: string | null | undefined) {
  if (outputSummary) return outputSummary;
  return status === "failed"
    ? "The run failed. Failure details are unavailable."
    : "No run result recorded.";
}

export function reviewTextPreview(value: string, expanded: boolean, limit = REVIEW_SUMMARY_PREVIEW_LIMIT) {
  const truncated = value.length > limit;
  const text = truncated && !expanded ? value.slice(0, limit) : value;
  return {
    text,
    truncated,
    remainingCharacters: truncated ? value.length - limit : 0,
  };
}
