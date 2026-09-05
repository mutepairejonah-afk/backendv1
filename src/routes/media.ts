import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { assertCanPostInConversation } from "../lib/permissions.js";

export const mediaRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

function decodeUpload(base64: string, contentType: string, maxBytes: number, allowed: RegExp): Buffer {
  if (!allowed.test(contentType)) throw new Error("Unsupported file type");
  const normalized = base64.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error("Invalid file data");
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length || buffer.length > maxBytes) throw new Error("File exceeds the permitted size");
  return buffer;
}

mediaRouter.post("/upload-chat-media", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    conversationId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    fileBase64: z.string().min(1),
    contentType: z.string().min(1).max(100),
  }).parse(req.body);

  await assertCanPostInConversation(data.clerkUserId, data.conversationId);
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;

  const buffer = decodeUpload(data.fileBase64, data.contentType, 15 * 1024 * 1024, /^(image|video|audio)\//);
  const ext = data.fileName.split(".").pop() || "bin";
  const storagePath = `${data.conversationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from("chat-media").upload(storagePath, buffer, { contentType: data.contentType, upsert: false });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);

  const isVideo = data.contentType.startsWith("video/");
  const isImage = data.contentType.startsWith("image/");
  const isAudio = data.contentType.startsWith("audio/");

  const { data: message, error: msgError } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: data.clerkUserId, text: null, image_url: isImage ? urlData.publicUrl : null, video_url: isVideo ? urlData.publicUrl : null, audio_url: isAudio ? urlData.publicUrl : null, expires_at: expiresAt }).select().single();
  if (msgError) throw new Error(`Failed to save message: ${msgError.message}`);

  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  const { data: members } = await supabaseAdmin.from("conversation_members").select("id, unread_count").eq("conversation_id", data.conversationId).neq("clerk_user_id", data.clerkUserId);
  if (members?.length) {
    for (const m of members) await supabaseAdmin.from("conversation_members").update({ unread_count: ((m as any).unread_count || 0) + 1 }).eq("id", (m as any).id);
  }
  return message;
}));

mediaRouter.post("/upload-document-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), fileName: z.string().min(1).max(255), fileBase64: z.string().min(1), contentType: z.string().min(1).max(100), fileSize: z.number().int().min(0).max(15 * 1024 * 1024) }).parse(req.body);
  await assertCanPostInConversation(data.clerkUserId, data.conversationId);
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const buffer = decodeUpload(data.fileBase64, data.contentType, 15 * 1024 * 1024, /^(application\/pdf|text\/plain|image|video|audio)\//);
  if (Math.abs(buffer.length - data.fileSize) > 1024) throw new Error("Declared file size does not match uploaded data");
  const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${data.conversationId}/files/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabaseAdmin.storage.from("chat-media").upload(storagePath, buffer, { contentType: data.contentType, upsert: false });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;
  const { data: message, error } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: data.clerkUserId, file_url: urlData.publicUrl, file_name: data.fileName, file_size: data.fileSize, mime_type: data.contentType, expires_at: expiresAt }).select().single();
  if (error) throw new Error(`Failed to save document: ${error.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  const { data: members } = await supabaseAdmin.from("conversation_members").select("id, unread_count").eq("conversation_id", data.conversationId).neq("clerk_user_id", data.clerkUserId);
  if (members?.length) for (const m of members) await supabaseAdmin.from("conversation_members").update({ unread_count: ((m as any).unread_count || 0) + 1 }).eq("id", (m as any).id);
  return message;
}));

mediaRouter.post("/upload-avatar", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), fileBase64: z.string().min(1), contentType: z.string().min(1).max(100) }).parse(req.body);
  const buffer = decodeUpload(data.fileBase64, data.contentType, 5 * 1024 * 1024, /^image\//);
  const ext = data.contentType.split("/")[1] || "jpg";
  const storagePath = `avatars/${data.clerkUserId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from("chat-media").upload(storagePath, buffer, { contentType: data.contentType, upsert: true });
  if (uploadError) throw new Error(`Avatar upload failed: ${uploadError.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);
  await supabaseAdmin.from("profiles").update({ avatar_url: urlData.publicUrl }).eq("clerk_user_id", data.clerkUserId);
  return { publicUrl: urlData.publicUrl };
}));

mediaRouter.post("/upload-moment-image", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), fileName: z.string().min(1).max(255), fileBase64: z.string().min(1), contentType: z.string().min(1).max(100) }).parse(req.body);
  const buffer = decodeUpload(data.fileBase64, data.contentType, 10 * 1024 * 1024, /^image\//);
  const ext = data.fileName.split(".").pop() || "jpg";
  const storagePath = `${data.clerkUserId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from("moment-images").upload(storagePath, buffer, { contentType: data.contentType, upsert: false });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("moment-images").getPublicUrl(storagePath);
  return { publicUrl: urlData.publicUrl };
}));
