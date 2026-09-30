import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@task-weaver/contracts", "@task-weaver/core", "@task-weaver/db", "@task-weaver/realtime"],
};

export default nextConfig;
