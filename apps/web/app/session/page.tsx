import Link from "next/link";
import { BrandHero, BrandMark } from "../../components/brand-mark";

export default function AudienceSessions() {
  return (
    <main className="nerdlingo-shell mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-10 text-white">
      <div>
        <BrandHero />
        <div className="mt-5"><BrandMark dark /></div>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">Choose a session</h1>
        <p className="mt-3 text-lg leading-7 text-[#D8E3E6]">Live captions for Nerdearla sessions.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link className="nerdlingo-panel rounded-2xl border-l-4 border-l-[#00ACA8] p-6 text-xl font-semibold transition hover:-translate-y-0.5 hover:border-[#00ACA8] focus:outline-none focus:ring-2 focus:ring-[#FFBA00]" href="/session/stage-1">
          Stage 1
        </Link>
        <Link className="nerdlingo-panel rounded-2xl border-l-4 border-l-[#FFBA00] p-6 text-xl font-semibold transition hover:-translate-y-0.5 hover:border-[#FFBA00] focus:outline-none focus:ring-2 focus:ring-[#FFBA00]" href="/session/stage-2">
          Stage 2
        </Link>
      </div>
    </main>
  );
}
