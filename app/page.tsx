import type { Metadata } from "next";
import ScanWorkspace from "@/components/scan/ScanWorkspace";
import "./scan/scan.css";

export const metadata: Metadata = { title: "GridSentinel · Area Scan" };

export default function Page() {
  return <ScanWorkspace />;
}
