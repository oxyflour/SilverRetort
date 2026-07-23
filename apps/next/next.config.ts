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
  async headers() {
    return [{
      source: "/artifact-components/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }];
  },
  async rewrites() {
    const backend = (process.env.API_REWRITE ?? "http://127.0.0.1:23001/")
      .replace(/\/$/, "");
    return {
      beforeFiles: [
        {
          source: "/:path*",
          has: [
            {
              type: "host",
              value: "(?<artifactId>[a-z0-9](?:[a-z0-9-]{0,62}))\\.artifact\\.localhost(?::\\d+)?",
            },
          ],
          destination: `${backend}/__artifact-origin/:artifactId/:path*`,
        },
        {
          source: "/api/workspace-proxy/:path*",
          destination: `${backend}/api/workspace-proxy/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
