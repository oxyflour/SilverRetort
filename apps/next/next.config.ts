import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: path.join(configDir, "../../"),
  transpilePackages: [
    "silverretort-protocol",
    "silverretort-chat-ui",
    "silverretort-template-sdk",
    "silverretort-template-domain-ui",
    "silverretort-template-structural-design",
    "silverretort-template-antenna-design",
    "silverretort-template-industrial-design",
    "silverretort-template-algorithm-research",
  ],
  async rewrites() {
    const backend = (process.env.API_REWRITE ?? "http://127.0.0.1:23001/")
      .replace(/\/$/, "");
    return {
      beforeFiles: [
        {
          source: "/api/workspace-proxy/:path*",
          destination: `${backend}/api/workspace-proxy/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
