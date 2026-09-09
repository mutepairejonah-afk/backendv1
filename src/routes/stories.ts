import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const storiesRouter = Router();
const url = z.string().url().max(2048).optional();
const media = z.object({ text: z.string().max(5000).optional(), imageUrl: url, videoUrl: url, audioUrl: url, thumbnailUrl: url, mimeType: z.string().max(120).optional(), durationSeconds: z.number().int().min(0).max(86400).optional() });
const reply = async (res: any, fn: () => Promise<any>) => { try { res.json(await fn()); } catch (err: any) { const status = err?.name === "ZodError" ? 400 : 500; res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err?.message || "Internal server error") }); } };

storiesRouter.post("/create-story", requireAuth, (req, res) => reply(res, async () => {
  const data = media.extend({ clerkUserId: z.string().min(1).max(255), expiresInHours: z.number().int().min(1).max(168).optional() }).parse(req.body);
  if (!data.text?.trim() && !data.imageUrl && !data.videoUrl && !data.audioUrl) throw new Error("A story needs text, an image, video, or audio");
  const { clerkUserId, expiresInHours, ...payload } = data;
  const { data: story, error } = await supabaseAdmin.from("stories").insert({ clerk_user_id: clerkUserId, text: payload.text || null, image_url: payload.imageUrl || null, video_url: payload.videoUrl || null, audio_url: payload.audioUrl || null, thumbnail_url: payload.thumbnailUrl || null, mime_type: payload.mimeType || null, duration_seconds: payload.durationSeconds ?? null, expires_at: new Date(Date.now() + (expiresInHours ?? 24) * 3600000).toISOString() }).select().single();
  if (error) throw new Error(`Failed to create story: ${error.message}`);
  return story;
}));

storiesRouter.post("/get-stories", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: stories, error } = await supabaseAdmin.from("stories").select("*").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(`Failed to get stories: ${error.message}`);
  const ids = (stories || []).map((s: any) => s.id);
  const { data: views } = ids.length ? await supabaseAdmin.from("story_views").select("story_id, clerk_user_id").in("story_id", ids) : { data: [] };
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, username, avatar_url").in("clerk_user_id", [...new Set((stories || []).map((s: any) => s.clerk_user_id))]);
  return (stories || []).map((story: any) => ({ ...story, viewedByMe: (views || []).some((v: any) => v.story_id === story.id && v.clerk_user_id === data.clerkUserId), viewsCount: (views || []).filter((v: any) => v.story_id === story.id).length, profile: (profiles || []).find((p: any) => p.clerk_user_id === story.clerk_user_id) || null }));
}));

storiesRouter.post("/mark-story-viewed", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), storyId: z.string().uuid() }).parse(req.body);
  const { error } = await supabaseAdmin.from("story_views").upsert({ story_id: data.storyId, clerk_user_id: data.clerkUserId }, { onConflict: "story_id,clerk_user_id" });
  if (error) throw new Error(`Failed to mark story viewed: ${error.message}`);
  return { success: true };
}));

storiesRouter.post("/delete-story", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), storyId: z.string().uuid() }).parse(req.body);
  const { data: story } = await supabaseAdmin.from("stories").select("clerk_user_id").eq("id", data.storyId).maybeSingle();
  if (!story || story.clerk_user_id !== data.clerkUserId) throw new Error("You can only delete your own story");
  const { error } = await supabaseAdmin.from("stories").delete().eq("id", data.storyId);
  if (error) throw new Error(`Failed to delete story: ${error.message}`);
  return { success: true };
}));


storiesRouter.post("/get-story-view-counts", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), storyIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);
  const { data: owned } = await supabaseAdmin.from("stories").select("id").in("id", data.storyIds).eq("clerk_user_id", data.clerkUserId);
  const ownedIds = (owned || []).map((s: any) => s.id);
  if (!ownedIds.length) return {};
  const { data: views } = await supabaseAdmin.from("story_views").select("story_id").in("story_id", ownedIds);
  return ownedIds.reduce((out: Record<string, number>, id: string) => { out[id] = (views || []).filter((v: any) => v.story_id === id).length; return out; }, {});
}));

storiesRouter.post("/get-story-viewers", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), storyId: z.string().uuid() }).parse(req.body);
  const { data: story } = await supabaseAdmin.from("stories").select("id").eq("id", data.storyId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (!story) throw new Error("Only the story owner can view its viewers");
  const { data: views } = await supabaseAdmin.from("story_views").select("clerk_user_id, viewed_at").eq("story_id", data.storyId).order("viewed_at", { ascending: false });
  const ids = [...new Set((views || []).map((v: any) => v.clerk_user_id))];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, username, avatar_url").in("clerk_user_id", ids.length ? ids : ["__none__"]);
  return { viewers: (views || []).map((v: any) => ({ ...v, profile: (profiles || []).find((p: any) => p.clerk_user_id === v.clerk_user_id) || null })), count: views?.length || 0 };
}));
