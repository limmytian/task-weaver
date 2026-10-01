import { versionChecker } from "@task-weaver/core";
import { router, publicProcedure } from "../init";

export const versionRouter = router({
  info: publicProcedure.query(() => versionChecker.info()),
  check: publicProcedure.mutation(() => versionChecker.check()),
});
