/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

/**
 * Next.js Edge Middleware — per-request CSP nonce.
 *
 * Generates a fresh cryptographic nonce for every HTML request and injects it
 * into the Content-Security-Policy header. This eliminates 'unsafe-inline' from
 * script-src: only scripts carrying the matching nonce attribute are allowed to
 * execute, blocking injected scripts even if they bypass other defences.
 *
 * The nonce is forwarded as the `x-nonce` request header so that Next.js
 * automatically applies it to all hydration inline scripts it generates.
 */

import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  // One fresh nonce per request — base64-encoded UUID is URL-safe and opaque
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    "default-src 'self'",
    // Nonce replaces 'unsafe-inline'. unsafe-eval kept only in dev for HMR.
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind generates inline styles; unsafe-inline stays for style-src.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // Pass nonce to Next.js runtime — it applies it to hydration inline scripts
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Dynamic CSP overwrites the static header set in next.config.ts
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Skip static assets — they don't need per-request CSP nonces
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
