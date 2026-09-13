export function getBackendAdminIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_CLERK_IDS || process.env.ADMIN_CLERK_ID || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isBackendAdmin(clerkUserId: string): boolean {
  return getBackendAdminIds().has(clerkUserId);
}

export function requireBackendAdminConfigured(): void {
  if (!getBackendAdminIds().size) {
    throw new Error("No backend admin is configured. Set ADMIN_CLERK_ID or ADMIN_CLERK_IDS in the server environment.");
  }
}
