export const REVIEW_SUMMARY_PREVIEW_LIMIT = 4_000;

export function reviewTextPreview(value: string, expanded: boolean, limit = REVIEW_SUMMARY_PREVIEW_LIMIT) {
  const truncated = value.length > limit;
  const text = truncated && !expanded ? value.slice(0, limit) : value;
  return {
    text,
    truncated,
    remainingCharacters: truncated ? value.length - limit : 0,
  };
}
