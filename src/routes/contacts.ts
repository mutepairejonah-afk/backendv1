import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const contactsRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

contactsRouter.post("/get-contacts", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: rawContacts } = await supabaseAdmin.from("contacts").select("*").eq("user_clerk_id", data.clerkUserId).eq("status", "accepted");
  if (!rawContacts?.length) return [];
  const clerkIds = rawContacts.map((c: any) => c.contact_clerk_id);
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").in("clerk_user_id", clerkIds);
  return rawContacts.map((c: any) => ({ ...c, profile: profiles?.find((p: any) => p.clerk_user_id === c.contact_clerk_id) || null }));
}));

contactsRouter.post("/add-contact", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    contactClerkId: z.string().min(1).max(255),
    nickname: z.string().min(1).max(255).optional(),
  }).parse(req.body);
  if (data.clerkUserId === data.contactClerkId) throw new Error("You cannot add yourself as a contact");
  const { data: targetProfile } = await supabaseAdmin.from("profiles").select("clerk_user_id").eq("clerk_user_id", data.contactClerkId).single();
  if (!targetProfile) throw new Error("User not found");
  const { data: existing } = await supabaseAdmin.from("contacts").select("status").eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.contactClerkId).maybeSingle();
  if (existing?.status === "accepted") return { status: "accepted" as const };
  if (existing?.status === "pending_outgoing") return { status: "pending_outgoing" as const };
  if (existing?.status === "pending_incoming") {
    await supabaseAdmin.from("contacts").update({ status: "accepted" }).eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.contactClerkId);
    await supabaseAdmin.from("contacts").update({ status: "accepted" }).eq("user_clerk_id", data.contactClerkId).eq("contact_clerk_id", data.clerkUserId);
    return { status: "accepted" as const };
  }
  const { error: e1 } = await supabaseAdmin.from("contacts").upsert({ user_clerk_id: data.clerkUserId, contact_clerk_id: data.contactClerkId, nickname: data.nickname || null, status: "pending_outgoing" }, { onConflict: "user_clerk_id,contact_clerk_id" });
  if (e1) throw new Error(`Failed to send request: ${e1.message}`);
  const { error: e2 } = await supabaseAdmin.from("contacts").upsert({ user_clerk_id: data.contactClerkId, contact_clerk_id: data.clerkUserId, status: "pending_incoming" }, { onConflict: "user_clerk_id,contact_clerk_id" });
  if (e2) throw new Error(`Failed to deliver request: ${e2.message}`);
  return { status: "pending_outgoing" as const };
}));

contactsRouter.post("/remove-contact", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), contactClerkId: z.string().min(1).max(255) }).parse(req.body);
  await supabaseAdmin.from("contacts").delete().eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.contactClerkId);
  await supabaseAdmin.from("contacts").delete().eq("user_clerk_id", data.contactClerkId).eq("contact_clerk_id", data.clerkUserId);
  return { success: true };
}));

contactsRouter.post("/is-contact", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), contactClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: row } = await supabaseAdmin.from("contacts").select("status").eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.contactClerkId).maybeSingle();
  return { isContact: row?.status === "accepted", status: (row?.status || "none") as any };
}));

contactsRouter.post("/get-pending-requests", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: rows } = await supabaseAdmin.from("contacts").select("*").eq("user_clerk_id", data.clerkUserId).eq("status", "pending_incoming").order("created_at", { ascending: false });
  if (!rows?.length) return [];
  const ids = rows.map((r: any) => r.contact_clerk_id);
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").in("clerk_user_id", ids);
  return rows.map((r: any) => ({ ...r, profile: profiles?.find((p: any) => p.clerk_user_id === r.contact_clerk_id) || null }));
}));

contactsRouter.post("/get-outgoing-requests", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: rows } = await supabaseAdmin.from("contacts").select("*").eq("user_clerk_id", data.clerkUserId).eq("status", "pending_outgoing").order("created_at", { ascending: false });
  if (!rows?.length) return [];
  const ids = rows.map((r: any) => r.contact_clerk_id);
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").in("clerk_user_id", ids);
  return rows.map((r: any) => ({ ...r, profile: profiles?.find((p: any) => p.clerk_user_id === r.contact_clerk_id) || null }));
}));

contactsRouter.post("/accept-contact-request", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), requesterClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: incoming } = await supabaseAdmin.from("contacts").select("id").eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.requesterClerkId).eq("status", "pending_incoming").maybeSingle();
  if (!incoming) throw new Error("No pending request from this user");
  await supabaseAdmin.from("contacts").update({ status: "accepted" }).eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.requesterClerkId);
  await supabaseAdmin.from("contacts").update({ status: "accepted" }).eq("user_clerk_id", data.requesterClerkId).eq("contact_clerk_id", data.clerkUserId);
  return { success: true };
}));

contactsRouter.post("/reject-contact-request", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), requesterClerkId: z.string().min(1).max(255) }).parse(req.body);
  await supabaseAdmin.from("contacts").delete().eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.requesterClerkId);
  await supabaseAdmin.from("contacts").delete().eq("user_clerk_id", data.requesterClerkId).eq("contact_clerk_id", data.clerkUserId);
  return { success: true };
}));

contactsRouter.post("/get-notification-count", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { count: requestCount } = await supabaseAdmin.from("contacts").select("id", { count: "exact", head: true }).eq("user_clerk_id", data.clerkUserId).eq("status", "pending_incoming");
  const { data: memberships } = await supabaseAdmin.from("conversation_members").select("unread_count").eq("clerk_user_id", data.clerkUserId);
  const unreadMessages = (memberships || []).reduce((sum: number, m: any) => sum + (m.unread_count || 0), 0);
  return { pendingRequests: requestCount || 0, unreadMessages, total: (requestCount || 0) + unreadMessages };
}));

contactsRouter.post("/get-friend-suggestions", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: myContacts } = await supabaseAdmin.from("contacts").select("contact_clerk_id").eq("user_clerk_id", data.clerkUserId);
  const myContactIds = new Set((myContacts || []).map((c: any) => c.contact_clerk_id));
  myContactIds.add(data.clerkUserId);
  if (myContactIds.size <= 1) {
    const { data: recent } = await supabaseAdmin.from("profiles").select("*").neq("clerk_user_id", data.clerkUserId).not("display_name", "is", null).order("created_at", { ascending: false }).limit(8);
    return (recent || []).map((p: any) => ({ ...p, mutualCount: 0 }));
  }
  const contactIdArray = Array.from(myContactIds).filter((id) => id !== data.clerkUserId);
  const { data: secondDegree } = await supabaseAdmin.from("contacts").select("contact_clerk_id, user_clerk_id").in("user_clerk_id", contactIdArray).eq("status", "accepted").neq("contact_clerk_id", data.clerkUserId);
  if (!secondDegree?.length) {
    const { data: recent } = await supabaseAdmin.from("profiles").select("*").neq("clerk_user_id", data.clerkUserId).not("display_name", "is", null).order("created_at", { ascending: false }).limit(8);
    return (recent || []).map((p: any) => ({ ...p, mutualCount: 0 }));
  }
  const mutualMap = new Map<string, number>();
  for (const row of secondDegree) {
    if (!myContactIds.has((row as any).contact_clerk_id)) mutualMap.set((row as any).contact_clerk_id, (mutualMap.get((row as any).contact_clerk_id) || 0) + 1);
  }
  if (mutualMap.size === 0) {
    const { data: recent } = await supabaseAdmin.from("profiles").select("*").neq("clerk_user_id", data.clerkUserId).not("display_name", "is", null).order("created_at", { ascending: false }).limit(8);
    return (recent || []).map((p: any) => ({ ...p, mutualCount: 0 }));
  }
  const suggestedIds = Array.from(mutualMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").in("clerk_user_id", suggestedIds);
  return (profiles || []).map((p: any) => ({ ...p, mutualCount: mutualMap.get(p.clerk_user_id) || 0 }));
}));
