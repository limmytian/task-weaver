import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getWebRuntime, resolveWebRequestState } from "@/lib/web-runtime";

export default async function ExtensionPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const [{ slug }, requestHeaders] = await Promise.all([params, headers()]);
  const route = `/projects/extensions/${slug.join("/")}`;
  const webState = await resolveWebRequestState(getWebRuntime(), requestHeaders);
  const contribution = webState.contributions.pages.find((page) => page.route === route);
  if (!contribution) notFound();

  const Page = contribution.page.component;
  return <Page actor={webState.identity.actor} />;
}
