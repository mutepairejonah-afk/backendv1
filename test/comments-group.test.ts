import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userId = "user-member";
const channelId = "11111111-1111-4111-8111-111111111111";
const commentsGroupId = "22222222-2222-4222-8222-222222222222";

const state = {
  channel: {
    id: channelId,
    conversation_id: "33333333-3333-4333-8333-333333333333",
    name: "Announcements",
    is_broadcast: true,
  },
  commentsGroup: { conversation_id: commentsGroupId } as { conversation_id: string } | null,
  members: [{ clerk_user_id: userId, role: "member", joined_at: "2026-01-01T00:00:00.000Z" }],
};

function queryFor(table: string) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    maybeSingle: vi.fn(async () => {
      if (table === "channel_members") return { data: state.members[0], error: null };
      if (table === "channel_comments_links") return { data: state.commentsGroup, error: null };
      return { data: null, error: null };
    }),
    single: vi.fn(async () => {
      if (table === "channels") return { data: state.channel, error: null };
      return { data: null, error: null };
    }),
  };
  query.select.mockImplementation(() => query);
  query.eq.mockImplementation(() => query);
  query.in.mockImplementation(() => query);
  query.order.mockImplementation(() => query);
  return query;
}

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../src/lib/admin.js", () => ({ isBackendAdmin: () => false }));

vi.mock("../src/lib/supabase.js", () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => queryFor(table)),
  },
}));

const { operationsRouter } = await import("../src/routes/operations.js");
const { channelsRouter } = await import("../src/routes/channels.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", operationsRouter);
  app.use("/api", channelsRouter);
  return app;
}

describe("channel comments group endpoints", () => {
  beforeEach(() => {
    state.commentsGroup = { conversation_id: commentsGroupId };
  });

  it("returns the linked comments conversation ID for a channel member", async () => {
    const response = await request(createTestApp())
      .post("/api/getCommentsGroup")
      .send({ clerkUserId: userId, channelId });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversationId: commentsGroupId });
  });

  it("returns a null conversation ID when no comments group is linked", async () => {
    state.commentsGroup = null;

    const response = await request(createTestApp())
      .post("/api/getCommentsGroup")
      .send({ clerkUserId: userId, channelId });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversationId: null });
  });

  it("includes commentsGroupId in get-channel-info for non-admin members", async () => {
    const response = await request(createTestApp())
      .post("/api/get-channel-info")
      .send({ clerkUserId: userId, channelId });

    expect(response.status).toBe(200);
    expect(response.body.commentsGroupId).toBe(commentsGroupId);
    expect(response.body.members).toEqual([]);
  });
});
