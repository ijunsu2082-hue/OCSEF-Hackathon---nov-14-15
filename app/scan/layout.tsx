import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "GridSentinel · Area Scan" };

export default function ScanLayout({ children }: { children: ReactNode }) {
  return children;
}
