import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { isBackendAdmin } from "../lib/admin.js";

export const paymentsRouter = Router();
const reply = (res: any, fn: () => Promise<any>) => fn().then((value) => res.json(value)).catch((err: any) => res.status(err?.name === "ZodError" ? 400 : 500).json({ error: process.env.NODE_ENV === "production" && err?.name !== "ZodError" ? "Internal server error" : (err?.message || "Internal server error") }));
const userId = z.string().min(1).max(255);

function decodeScreenshot(base64: string, mimeType: string): Buffer {
  if (!/^image\/(jpeg|png)$/.test(mimeType)) throw new Error("Only JPEG and PNG screenshots are supported");
  const normalized = base64.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error("Invalid screenshot data");
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error("Screenshot exceeds the 10 MB limit");
  return buffer;
}

async function assertPaymentAdmin(clerkUserId: string) {
  if (isBackendAdmin(clerkUserId)) return;
  const { data: profile } = await supabaseAdmin.from("profiles").select("is_admin").eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!profile?.is_admin) throw new Error("Access denied. Admin privileges required.");
}

paymentsRouter.post("/upload-payment-screenshot", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: userId, fileBase64: z.string().min(1), mimeType: z.enum(["image/jpeg", "image/png"]), fileName: z.string().min(1).max(255) }).parse(req.body);
  const buffer = decodeScreenshot(data.fileBase64, data.mimeType);
  const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `payments/${data.clerkUserId}/${Date.now()}-${safeName}`;
  const { error } = await supabaseAdmin.storage.from("payment-screenshots").upload(storagePath, buffer, { contentType: data.mimeType, upsert: false });
  if (error) throw new Error(`Screenshot upload failed: ${error.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("payment-screenshots").getPublicUrl(storagePath);
  return { url: urlData.publicUrl };
}));

paymentsRouter.post("/submit-payment", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: userId, displayName: z.string().max(100).optional(), amount: z.number().positive(), currency: z.enum(["USD", "ZiG"]), transactionId: z.string().min(1).max(25), screenshotUrl: z.string().url().optional(), disputeNote: z.string().max(500).optional() }).parse(req.body);
  const normalizedTxId = data.transactionId.toUpperCase().trim();
  const { data: existing } = await supabaseAdmin.from("payments").select("id").eq("transaction_id", normalizedTxId).maybeSingle();
  if (existing) throw new Error("This transaction ID has already been submitted. If this is an error, use the dispute option.");
  const { data: payment, error } = await supabaseAdmin.from("payments").insert({ user_id: data.clerkUserId, user_display_name: data.displayName || null, amount: data.amount, currency: data.currency, transaction_id: normalizedTxId, status: "pending", screenshot_url: data.screenshotUrl || null, dispute_note: data.disputeNote || null }).select().single();
  if (error) throw new Error(error.message);
  return payment;
}));

paymentsRouter.post("/get-user-payments", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: userId }).parse(req.body);
  const { data: rows, error } = await supabaseAdmin.from("payments").select("*").eq("user_id", data.clerkUserId).order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return rows || [];
}));

paymentsRouter.post("/get-admin-payments", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: userId, status: z.enum(["pending", "approved", "rejected"]).optional().default("pending") }).parse(req.body);
  await assertPaymentAdmin(data.clerkUserId);
  const { data: rows, error } = await supabaseAdmin.from("payments").select("*").eq("status", data.status).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return rows || [];
}));

paymentsRouter.post("/verify-order", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: userId, paymentId: z.string().uuid(), action: z.enum(["approved", "rejected"]), rejectionReason: z.string().max(500).optional() }).parse(req.body);
  await assertPaymentAdmin(data.clerkUserId);
  const { data: payment, error: fetchError } = await supabaseAdmin.from("payments").select("user_id, amount, currency").eq("id", data.paymentId).eq("status", "pending").maybeSingle();
  if (fetchError || !payment) throw new Error("Payment not found or already processed.");
  const { error } = await supabaseAdmin.from("payments").update({ status: data.action, approved_by: data.clerkUserId, processed_at: new Date().toISOString(), rejection_reason: data.rejectionReason || null }).eq("id", data.paymentId).eq("status", "pending");
  if (error) throw new Error(error.message);
  if (data.action === "approved") {
    const amountUsd = payment.currency === "USD" ? Number(payment.amount) : Number(payment.amount) / 13.5;
    await supabaseAdmin.from("profiles").update({ subscription_tier: amountUsd >= 9.99 ? "pro" : "premium" }).eq("clerk_user_id", payment.user_id);
  }
  return { success: true };
}));

paymentsRouter.post("/get-ecocash-settings", requireAuth, (req, res) => reply(res, async () => {
  z.object({}).passthrough().parse(req.body || {});
  const { data, error } = await supabaseAdmin.from("ecocash_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data || { id: 1, usd_to_zig_rate: 13.5, ecocash_number: "0788800342" };
}));

paymentsRouter.post("/update-ecocash-settings", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ clerkUserId: userId, usdToZigRate: z.number().positive(), ecocashNumber: z.string().min(3).max(40) }).parse(req.body);
  await assertPaymentAdmin(data.clerkUserId);
  const { error } = await supabaseAdmin.from("ecocash_settings").upsert({ id: 1, usd_to_zig_rate: data.usdToZigRate, ecocash_number: data.ecocashNumber, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return { success: true };
}));
