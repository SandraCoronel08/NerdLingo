import OverlayClient from "./overlay-client";
import { overlayLanguageFromQuery } from "../../../lib/caption-language";

type SessionId = "stage-1" | "stage-2";

function validSessionId(value: string): SessionId {
  return value === "stage-2" ? "stage-2" : "stage-1";
}

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ sessionId }, { lang }] = await Promise.all([params, searchParams]);

  return <OverlayClient sessionId={validSessionId(sessionId)} language={overlayLanguageFromQuery(lang)} />;
}
