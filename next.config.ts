import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // OneDrive intermittently drops freshly written files inside dot-directories
  // such as .next, which aborts dev/build at manifest collection. Keep output in
  // a plain directory so `next dev`/`build`/`start` stay stable here.
  // `NEXT_DIST_DIR` lets a verification build use its own folder while other
  // dev servers in this checkout keep writing the default one.
  // Dev and production builds must not share the folder: a running `next dev`
  // deletes manifests out from under `next build`, which fails with ENOENT at
  // "Collecting page data".
  distDir:
    process.env.NEXT_DIST_DIR ??
    (process.env.NODE_ENV === "development" ? "build-dev" : "build-out"),
  // A package-lock.json in the user profile makes Next infer that directory as
  // the workspace root, so file tracing walks the whole home folder. Pin it to
  // this project: builds stay fast and the output stays reproducible.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
