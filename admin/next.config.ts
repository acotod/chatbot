import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

const apiProxyTarget = process.env.API_PROXY_TARGET?.trim() || "http://api:3000";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return [
      {
        source: "/auth/:path*",
        destination: `${apiProxyTarget}/auth/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
