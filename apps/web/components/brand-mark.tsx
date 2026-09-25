import Image from "next/image";

export function BrandMark({ compact = false, dark = false }: { compact?: boolean; dark?: boolean }) {
  return <div className="flex items-center gap-2.5">
    <Image className="h-11 w-9 object-contain" src="/brand/nerdearla-n-simplificado.png" alt="Nerdearla" width={884} height={1055} priority />
    <div className="leading-none">
      {!compact ? <p className={`text-xs font-semibold uppercase tracking-[0.16em] ${dark ? "text-[#D8E3E6]" : "text-[#34495E]"}`}>Nerdearla</p> : null}
      <p className={`mt-1 text-sm font-semibold tracking-tight ${dark ? "text-white" : "text-[#1A1A1A]"}`}>NerdLingo</p>
    </div>
  </div>;
}

export function BrandHero() {
  return <div className="brand-hero-mark">
    <Image className="h-9 w-auto object-contain sm:h-11" src="/brand/nerdearla-simplificado.png" alt="Nerdearla" width={4469} height={1055} priority />
    <span>NerdLingo / Live operations</span>
  </div>;
}
