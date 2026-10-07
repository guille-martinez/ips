import type { NextConfig } from "next";

const config: NextConfig = {
  // better-sqlite3 is a native module: keep it out of the server bundle.
  serverExternalPackages: ["better-sqlite3"],
  devIndicators: false,
};

export default config;
