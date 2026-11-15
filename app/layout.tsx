import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mapergy — Infrastructure energy intelligence",
  description:
    "Map every facility, score its energy risk, stress-test it, and turn the result into a funded upgrade plan.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
