import OverlayClient from "./overlay-client";

type SessionId = "stage-1" | "stage-2";
type OverlayLanguage = "es" | "original";

function validSessionId(value: string): SessionId {
  return value === "stage-2" ? "stage-2" : "stage-1";
}

function validLanguage(value: string | undefined): OverlayLanguage {
  return value === "original" ? "original" : "es";
}

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ sessionId }, { lang }] = await Promise.all([params, searchParams]);

  return <OverlayClient sessionId={validSessionId(sessionId)} language={validLanguage(lang)} />;
}
