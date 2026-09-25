import { beforeEach, describe, expect, it, vi } from "vitest";

const permissionState = vi.hoisted(() => ({
  conversationType: "channel",
  onlyAdminsSend: false,
  channel: { id: "channel-id" } as { id: string } | null,
  member: { role: "member" as "member" | "admin" } as { role: "member" | "admin" } | null,
}));

function queryFor(table: string) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => {
      if (table === "conversation_members" || table === "channel_members") return { data: permissionState.member, error: null };
      if (table === "channels") return { data: permissionState.channel, error: null };
      return { data: null, error: null };
    }),
    single: vi.fn(async () => ({
      data: { type: permissionState.conversationType, only_admins_send: permissionState.onlyAdminsSend },
      error: null,
    })),
  };
  return query;
}

vi.mock("../src/lib/supabase.js", () => ({
  supabaseAdmin: { from: vi.fn((table: string) => queryFor(table)) },
}));

const { assertCanPostInConversation } = await import("../src/lib/permissions.js");

describe("conversation posting permissions", () => {
  beforeEach(() => {
    permissionState.conversationType = "channel";
    permissionState.onlyAdminsSend = false;
    permissionState.channel = { id: "channel-id" };
    permissionState.member = { role: "member" };
  });

  it("rejects a non-admin channel member from posting media or text", async () => {
    await expect(assertCanPostInConversation("member-user", "conversation-id")).rejects.toThrow("Only channel admins");
  });

  it("allows a channel admin to post media or text", async () => {
    permissionState.member = { role: "admin" };
    await expect(assertCanPostInConversation("admin-user", "conversation-id")).resolves.toBeUndefined();
  });

  it("rejects media/text posting by a non-member", async () => {
    permissionState.member = null;
    await expect(assertCanPostInConversation("outsider", "conversation-id")).rejects.toThrow("not a member");
  });

  it("keeps group only-admins-send enforcement", async () => {
    permissionState.conversationType = "group";
    permissionState.onlyAdminsSend = true;
    await expect(assertCanPostInConversation("member-user", "conversation-id")).rejects.toThrow("Only admins");
  });
});
