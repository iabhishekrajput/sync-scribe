import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  output: "standalone",
  outputFileTracingRoot: repoRoot,
};

export default config;
