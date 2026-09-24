import Link from "next/link";

export default function AudienceSessions() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 bg-slate-950 px-6 py-12 text-white">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">NerdLingo</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Choose a session</h1>
        <p className="mt-3 text-lg leading-7 text-slate-300">Live captions for Nerdearla sessions.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link className="rounded-2xl border border-slate-700 bg-slate-900 p-6 text-xl font-semibold transition hover:border-cyan-300 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-300" href="/session/stage-1">
          Stage 1
        </Link>
        <Link className="rounded-2xl border border-slate-700 bg-slate-900 p-6 text-xl font-semibold transition hover:border-cyan-300 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-300" href="/session/stage-2">
          Stage 2
        </Link>
      </div>
    </main>
  );
}
