const localBackendUrl = "http://localhost:3001";

/**
 * Builds a browser WebSocket URL for the configured NerdLingo backend.
 * NEXT_PUBLIC_BACKEND_URL is intentionally public: it contains only the
 * backend origin, never a credential.
 */
export function backendWebSocketUrl(pathname: "/audio" | "/view", sessionId: string) {
  const url = new URL(process.env.NEXT_PUBLIC_BACKEND_URL || localBackendUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set("session", sessionId);
  return url.toString();
}
