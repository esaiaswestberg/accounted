import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const activepiecesUrl = process.env.ACTIVEPIECES_URL ?? "";

const cspDirectives = [
  "default-src 'self'",
  `connect-src 'self' ${supabaseUrl} https://*.supabase.co wss://*.supabase.co https://*.enablebanking.com https://*.recapt.app`,
  `style-src 'self' 'unsafe-inline' https://*.enablebanking.com`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://*.enablebanking.com https://cdn.recapt.app`,
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  `frame-src 'self'${activepiecesUrl ? ` ${activepiecesUrl}` : ""}`,
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep pdfjs-dist out of the bundle. The legacy build references
  // @napi-rs/canvas at module load and breaks Vercel's bundling step.
  // Text extraction works in pure Node once DOM globals are stubbed at
  // the call site (see extensions/general/invoice-inbox/lib/extract-invoice-fields.ts).
  serverExternalPackages: ['pdfjs-dist'],
  async redirects() {
    return [
      {
        source: '/nyckeltal',
        destination: '/kpi',
        permanent: true,
      },
    ]
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: cspDirectives,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
