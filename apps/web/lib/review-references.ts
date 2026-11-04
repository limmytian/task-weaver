export type ReviewReference = { target: string; comment: string };

export function formatReviewDecision(reason: string, references: ReviewReference[]): string {
  const summary = reason.trim();
  if (!references.length) return summary;
  return `${summary}\n\nReferenced feedback:\n${references.map((reference, index) => `${index + 1}. ${reference.target}\n   ${reference.comment.trim()}`).join('\n\n')}`;
}
