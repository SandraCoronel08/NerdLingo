import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NerdLingo",
  description: "Open-source real-time captions for conferences.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
