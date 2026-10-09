import { z } from "zod";

export const APPLICATION_VERSION = "0.3.6";
export const RELEASES_URL = "https://github.com/limmytian/task-weaver/releases";
export const versionStatusSchema = z.object({
  installed: z.object({ version: z.string(), commit: z.string().nullable(), development: z.boolean() }),
  status: z.enum(["not_checked", "disabled", "current", "update_available", "ahead", "unavailable", "rate_limited"]),
  latest: z.object({ version: z.string(), url: z.string().url(), publishedAt: z.string().nullable() }).nullable(),
  checkedAt: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  releasesUrl: z.literal(RELEASES_URL),
});
export type VersionStatus = z.infer<typeof versionStatusSchema>;
