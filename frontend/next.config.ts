import type { NextConfig } from "next";

const API_TARGET = process.env.DOCS_API_PROXY_TARGET || "http://localhost:5100";

const nextConfig: NextConfig = {
  // Hide the Next.js "N" logo / static indicator in the corner during `next dev`
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_TARGET}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
