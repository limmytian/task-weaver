import { versionChecker } from "@task-weaver/core";
import { router, publicProcedure, protectedProcedure } from "../init";

export const versionRouter = router({
  info: publicProcedure.query(() => versionChecker.info()),
  check: protectedProcedure.mutation(() => versionChecker.check()),
});
