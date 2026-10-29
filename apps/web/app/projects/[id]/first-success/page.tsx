"use client";

import { use } from "react";
import Link from "next/link";
import { FirstSuccessGuide } from "@/components/first-success-guide";
import { SidebarTrigger } from "@/components/ui/sidebar";

export default function FirstSuccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <main className="min-w-0 space-y-4 p-4 md:p-6"><div className="flex items-center gap-3"><SidebarTrigger /><Link className="underline" href={`/projects/${id}`}>Back to project</Link></div><FirstSuccessGuide projectId={id} /></main>;
}
