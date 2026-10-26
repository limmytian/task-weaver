/** Next.js owns/deletes its output directory; performance runs must not reuse unrelated paths. */
export function performanceBuildDirectory(value: string | undefined) {
  if (value === undefined) return ".next";
  if (!/^\.next-perf-[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("Performance build directory must be a dedicated .next-perf-* basename");
  }
  return value;
}
