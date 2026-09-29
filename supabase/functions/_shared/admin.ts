export function getBackendAdminIds(): Set<string> {
  return new Set(
    (Deno.env.get("ADMIN_CLERK_IDS") || Deno.env.get("ADMIN_CLERK_ID") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isBackendAdmin(clerkUserId: string): boolean {
  return getBackendAdminIds().has(clerkUserId);
}
