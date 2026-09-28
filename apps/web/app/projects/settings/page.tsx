import { redirect } from "next/navigation";

export default function SettingsPage() {
  redirect("/projects/settings/api-keys");
}
