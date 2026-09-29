// Ports src/routes/media.ts (Node backend) to a Supabase Edge Function.
// Deploy with: supabase functions deploy media
// Call at: https://<project>.supabase.co/functions/v1/media<original-path>
//
// upload-video-status and upload-story-media are NOT ported as single
// base64-body endpoints: Edge Functions have a 256MB memory ceiling, and a
// 100MB video becomes ~133MB of base64 JSON text plus a ~100MB decoded
// buffer -- comfortably enough to blow the limit and fail with a 546
// WORKER_RESOURCE_LIMIT error. Instead, each becomes a two-step flow:
//   1. Client asks this function for a signed upload URL (tiny request).
//   2. Client PUTs the raw file bytes DIRECTLY to Supabase Storage using
//      that URL -- the file body never passes through this function at all,
//      so there is no size ceiling to worry about here.
//   3. Client calls this function again to finalize (create the DB row /
//      confirm the upload and get back the public URL + size).
import { z } from "npm:zod@^3";
import { serve, type Handler } from "../_shared/serve.ts";
import { supabaseAdmin } from "../_shared/supabase-admin.ts";
import { assertCanPostInConversation } from "../_shared/permissions.ts";
import { decodeUpload } from "../_shared/upload.ts";
import { notifyRenderBroadcast } from "../_shared/broadcast.ts";

const routes: Record<string, Handler> = {};

routes["/upload-chat-media"] = async (body, clerkUserId) => {
  const data = z.object({
    conversationId: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    fileBase64: z.string().min(1),
    contentType: z.string().min(1).max(100),
  }).parse(body);

  await assertCanPostInConversation(clerkUserId, data.conversationId);
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
  const mediaType = isVideo ? "video" : isAudio ? "audio" : "image";

  const { data: message, error: msgError } = await supabaseAdmin.from("messages").insert({
    conversation_id: data.conversationId, sender_clerk_id: clerkUserId, text: null,
    image_url: isImage ? urlData.publicUrl : null, video_url: isVideo ? urlData.publicUrl : null, audio_url: isAudio ? urlData.publicUrl : null,
    file_name: data.fileName, file_size: buffer.length, mime_type: data.contentType, media_type: mediaType, expires_at: expiresAt,
  }).select().single();
  if (msgError) throw new Error(`Failed to save message: ${msgError.message}`);

  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  const { data: members } = await supabaseAdmin.from("conversation_members").select("id, unread_count").eq("conversation_id", data.conversationId).neq("clerk_user_id", clerkUserId);
  if (members?.length) for (const m of members as any[]) await supabaseAdmin.from("conversation_members").update({ unread_count: (m.unread_count || 0) + 1 }).eq("id", m.id);
  return message;
};

routes["/upload-document-message"] = async (body, clerkUserId) => {
  const data = z.object({
    conversationId: z.string().uuid(), fileName: z.string().min(1).max(255), fileBase64: z.string().min(1),
    contentType: z.string().min(1).max(100), fileSize: z.number().int().min(0).max(15 * 1024 * 1024),
  }).parse(body);
  await assertCanPostInConversation(clerkUserId, data.conversationId);
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const buffer = decodeUpload(data.fileBase64, data.contentType, 15 * 1024 * 1024, /^(application\/pdf|text\/plain|image|video|audio)\//);
  if (Math.abs(buffer.length - data.fileSize) > 1024) throw new Error("Declared file size does not match uploaded data");
  const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${data.conversationId}/files/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabaseAdmin.storage.from("chat-media").upload(storagePath, buffer, { contentType: data.contentType, upsert: false });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;
  const { data: message, error } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: clerkUserId, file_url: urlData.publicUrl, file_name: data.fileName, file_size: data.fileSize, mime_type: data.contentType, expires_at: expiresAt }).select().single();
  if (error) throw new Error(`Failed to save document: ${error.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  const { data: members } = await supabaseAdmin.from("conversation_members").select("id, unread_count").eq("conversation_id", data.conversationId).neq("clerk_user_id", clerkUserId);
  if (members?.length) for (const m of members as any[]) await supabaseAdmin.from("conversation_members").update({ unread_count: (m.unread_count || 0) + 1 }).eq("id", m.id);
  return message;
};

routes["/upload-avatar"] = async (body, clerkUserId) => {
  const data = z.object({ fileBase64: z.string().min(1), contentType: z.string().min(1).max(100) }).parse(body);
  const buffer = decodeUpload(data.fileBase64, data.contentType, 5 * 1024 * 1024, /^image\//);
  const ext = data.contentType.split("/")[1] || "jpg";
  const storagePath = `avatars/${clerkUserId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from("chat-media").upload(storagePath, buffer, { contentType: data.contentType, upsert: true });
  if (uploadError) throw new Error(`Avatar upload failed: ${uploadError.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);
  const { error: profileError } = await supabaseAdmin.from("profiles").update({ avatar_url: urlData.publicUrl }).eq("clerk_user_id", clerkUserId);
  if (profileError) throw new Error(`Failed to save avatar profile: ${profileError.message}`);
  return { publicUrl: urlData.publicUrl };
};

routes["/upload-moment-image"] = async (body, clerkUserId) => {
  const data = z.object({ fileName: z.string().min(1).max(255), fileBase64: z.string().min(1), contentType: z.string().min(1).max(100) }).parse(body);
  const buffer = decodeUpload(data.fileBase64, data.contentType, 10 * 1024 * 1024, /^image\//);
  const ext = data.fileName.split(".").pop() || "jpg";
  const storagePath = `${clerkUserId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage.from("moment-images").upload(storagePath, buffer, { contentType: data.contentType, upsert: false });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("moment-images").getPublicUrl(storagePath);
  return { publicUrl: urlData.publicUrl };
};

// ── Large-video flow, step 1: get a signed URL, upload bytes directly to
//    Storage (client PUTs to signedUrl with the given contentType header) ──
routes["/create-video-status-upload-url"] = async (body, clerkUserId) => {
  const data = z.object({ fileName: z.string().min(1).max(255) }).parse(body);
  const ext = data.fileName.split(".").pop() || "mp4";
  const path = `${clerkUserId}/videos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { data: signed, error } = await supabaseAdmin.storage.from("moment-media").createSignedUploadUrl(path);
  if (error) throw new Error(`Failed to create upload URL: ${error.message}`);
  return { uploadUrl: signed.signedUrl, token: signed.token, path };
};

// ── Step 2: after the client has PUT the video to `path`, create the moment
//    row and trigger the realtime broadcast the old single-step endpoint did ──
routes["/finalize-video-status"] = async (body, clerkUserId) => {
  const data = z.object({
    path: z.string().min(1).max(500), contentType: z.string().regex(/^video\//).max(100),
    text: z.string().max(5000).optional(), thumbnailUrl: z.string().url().max(2048).optional(), durationSeconds: z.number().int().min(0).max(86400).optional(),
  }).parse(body);
  if (!data.path.startsWith(`${clerkUserId}/videos/`)) throw new Error("Path does not belong to this upload session");
  const dir = data.path.slice(0, data.path.lastIndexOf("/"));
  const fileName = data.path.slice(data.path.lastIndexOf("/") + 1);
  const { data: listing, error: listError } = await supabaseAdmin.storage.from("moment-media").list(dir, { search: fileName });
  if (listError || !listing?.length) throw new Error("Upload not found -- did the upload to Storage complete?");
  const { data: urlData } = supabaseAdmin.storage.from("moment-media").getPublicUrl(data.path);
  const { data: moment, error } = await supabaseAdmin.from("moments").insert({
    clerk_user_id: clerkUserId, text: data.text || null, video_url: urlData.publicUrl, thumbnail_url: data.thumbnailUrl || null,
    mime_type: data.contentType, duration_seconds: data.durationSeconds ?? null, expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
  }).select().single();
  if (error) throw new Error(`Failed to save video status: ${error.message}`);
  await notifyRenderBroadcast("/internal/broadcast-moment-created", { momentId: moment.id });
  return moment;
};

// ── Story media flow, step 1 ──
routes["/create-story-media-upload-url"] = async (body, clerkUserId) => {
  const data = z.object({ fileName: z.string().min(1).max(255), contentType: z.string().regex(/^(image|video|audio)\//).max(100) }).parse(body);
  const ext = data.fileName.split(".").pop() || "bin";
  const path = `${clerkUserId}/stories/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { data: signed, error } = await supabaseAdmin.storage.from("moment-media").createSignedUploadUrl(path);
  if (error) throw new Error(`Failed to create upload URL: ${error.message}`);
  return { uploadUrl: signed.signedUrl, token: signed.token, path };
};

// ── Step 2: confirm the upload landed and return the same shape the old
//    single-step endpoint did, so the existing "create story" call elsewhere
//    in the app (src/routes/stories.ts on the Node backend) needs no change ──
routes["/confirm-story-media-upload"] = async (body, clerkUserId) => {
  const data = z.object({ path: z.string().min(1).max(500), contentType: z.string().regex(/^(image|video|audio)\//).max(100) }).parse(body);
  if (!data.path.startsWith(`${clerkUserId}/stories/`)) throw new Error("Path does not belong to this upload session");
  const dir = data.path.slice(0, data.path.lastIndexOf("/"));
  const fileName = data.path.slice(data.path.lastIndexOf("/") + 1);
  const { data: listing, error: listError } = await supabaseAdmin.storage.from("moment-media").list(dir, { search: fileName });
  if (listError || !listing?.length) throw new Error("Upload not found -- did the upload to Storage complete?");
  const { data: urlData } = supabaseAdmin.storage.from("moment-media").getPublicUrl(data.path);
  return { publicUrl: urlData.publicUrl, contentType: data.contentType, fileSize: listing[0].metadata?.size ?? null };
};

serve(routes);
