"use client";

export async function pluginManagementRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) {
    const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!challenge.ok) throw new Error("Sign in again before changing plugins.");
    const { csrfToken } = await challenge.json() as { csrfToken: string };
    headers.set("x-csrf-token", csrfToken); headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api/plugin-management${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Plugin service is unavailable.");
  return data as T;
}
