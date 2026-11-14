import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // OneDrive intermittently drops freshly written files inside dot-directories
  // such as .next, which aborts builds at manifest/trace collection. Keep build
  // output in a plain directory so `next dev`/`build`/`start` stay stable here.
  distDir: "build-out",
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
