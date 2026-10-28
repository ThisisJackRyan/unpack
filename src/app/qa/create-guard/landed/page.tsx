import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { qaRoutesEnabled } from "@/lib/qa-routes";

// Where the QA create action's redirect goes. 404 unless UNPACK_QA_ROUTES=1.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "QA landed", robots: { index: false, follow: false } };

export default function QaCreateLandedPage() {
  if (!qaRoutesEnabled()) notFound();
  return <p data-qa="landed">QA create landed.</p>;
}
