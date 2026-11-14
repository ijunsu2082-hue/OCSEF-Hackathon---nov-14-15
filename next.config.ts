import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A package-lock.json in the user profile makes Next infer that directory as
  // the workspace root, so file tracing walks the whole home folder. Pin it to
  // this project: builds stay fast and the output stays reproducible.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
