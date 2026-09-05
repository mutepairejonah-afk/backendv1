import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const momentsRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

momentsRouter.post("/get-moments", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: moments, error } = await supabaseAdmin.from("moments").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(`Failed to get moments: ${error.message}`);
  if (!moments?.length) return [];
  const clerkIds = [...new Set(moments.map((m: any) => m.clerk_user_id))];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").in("clerk_user_id", clerkIds);
  const momentIds = moments.map((m: any) => m.id);
  const { data: likes } = await supabaseAdmin.from("moment_likes").select("moment_id, clerk_user_id").in("moment_id", momentIds);
  const { data: comments } = await supabaseAdmin.from("moment_comments").select("moment_id").in("moment_id", momentIds);
  return moments.map((m: any) => {
    const momentLikes = likes?.filter((l: any) => l.moment_id === m.id) || [];
    const momentComments = comments?.filter((c: any) => c.moment_id === m.id) || [];
    return { ...m, profile: profiles?.find((p: any) => p.clerk_user_id === m.clerk_user_id) || null, likesCount: momentLikes.length, commentsCount: momentComments.length, likedByMe: momentLikes.some((l: any) => l.clerk_user_id === data.clerkUserId) };
  });
}));

momentsRouter.post("/create-moment", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), text: z.string().max(5000).optional(), imageUrl: z.string().url().max(2048).optional() }).parse(req.body);
  if (!data.text?.trim() && !data.imageUrl) throw new Error("A moment must have text or an image/video.");
  const { data: moment, error } = await supabaseAdmin.from("moments").insert({ clerk_user_id: data.clerkUserId, text: data.text || null, image_url: data.imageUrl || null }).select().single();
  if (error) throw new Error(`Failed to create moment: ${error.message}`);
  return moment;
}));

momentsRouter.post("/toggle-moment-like", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), momentId: z.string().uuid() }).parse(req.body);
  const { data: existing } = await supabaseAdmin.from("moment_likes").select("id").eq("moment_id", data.momentId).eq("clerk_user_id", data.clerkUserId).single();
  if (existing) { await supabaseAdmin.from("moment_likes").delete().eq("id", existing.id); return { liked: false }; }
  await supabaseAdmin.from("moment_likes").insert({ moment_id: data.momentId, clerk_user_id: data.clerkUserId });
  return { liked: true };
}));

momentsRouter.post("/get-moment-comments", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ momentId: z.string().uuid() }).parse(req.body);
  const { data: comments, error } = await supabaseAdmin.from("moment_comments").select("*").eq("moment_id", data.momentId).order("created_at", { ascending: true }).limit(100);
  if (error) throw new Error(`Failed to get comments: ${error.message}`);
  if (!comments?.length) return [];
  const clerkIds = [...new Set(comments.map((c: any) => c.clerk_user_id))];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url").in("clerk_user_id", clerkIds);
  return comments.map((c: any) => ({ ...c, profile: profiles?.find((p: any) => p.clerk_user_id === c.clerk_user_id) || null }));
}));

momentsRouter.post("/add-moment-comment", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), momentId: z.string().uuid(), text: z.string().min(1).max(2000) }).parse(req.body);
  const { data: comment, error } = await supabaseAdmin.from("moment_comments").insert({ moment_id: data.momentId, clerk_user_id: data.clerkUserId, text: data.text }).select().single();
  if (error) throw new Error(`Failed to add comment: ${error.message}`);
  return comment;
}));

momentsRouter.post("/delete-moment", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), momentId: z.string().uuid() }).parse(req.body);
  const { data: moment } = await supabaseAdmin.from("moments").select("clerk_user_id").eq("id", data.momentId).single();
  if (!moment || moment.clerk_user_id !== data.clerkUserId) throw new Error("Not authorized to delete this moment");
  await supabaseAdmin.from("moment_comments").delete().eq("moment_id", data.momentId);
  await supabaseAdmin.from("moment_likes").delete().eq("moment_id", data.momentId);
  await supabaseAdmin.from("moments").delete().eq("id", data.momentId);
  return { success: true };
}));

momentsRouter.post("/delete-moment-comment", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), commentId: z.string().uuid() }).parse(req.body);
  const { data: comment } = await supabaseAdmin.from("moment_comments").select("clerk_user_id").eq("id", data.commentId).single();
  if (!comment || comment.clerk_user_id !== data.clerkUserId) throw new Error("Not authorized to delete this comment");
  await supabaseAdmin.from("moment_comments").delete().eq("id", data.commentId);
  return { success: true };
}));
