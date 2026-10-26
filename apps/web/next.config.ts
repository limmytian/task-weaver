import type { NextConfig } from "next";
import { performanceBuildDirectory } from "./lib/performance-build-directory";

const nextConfig: NextConfig = {
  distDir: performanceBuildDirectory(process.env.TW_PERFORMANCE_WEB_DIST_DIR),
  ...(process.env.TW_PERFORMANCE_WEB_DIST_DIR ? {
    experimental: { cpus: 1, webpackMemoryOptimizations: true },
  } : {}),
  output: "standalone",
  transpilePackages: ["@task-weaver/contracts", "@task-weaver/core", "@task-weaver/db", "@task-weaver/realtime"],
};

export default nextConfig;
