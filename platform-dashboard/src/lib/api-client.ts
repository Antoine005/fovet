/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

// Single-flight guard: if multiple requests get 401 at the same time, only
// one refresh attempt is made and all callers await the same promise.
let _refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
    .then((r) => r.ok)
    .finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const req: RequestInit = {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  };

  const res = await fetch(url, req);

  // On 401: attempt silent token refresh, then retry once.
  // Auth routes are excluded to avoid infinite loops.
  if (res.status === 401 && !url.includes("/api/auth/")) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return fetch(url, req);
    }
    // Refresh also failed — clear session and go to login
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    window.location.href = "/login";
  }

  return res;
}
