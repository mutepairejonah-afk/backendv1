// Ports src/routes/payments.ts (Node backend) to a Supabase Edge Function.
// Deploy with: supabase functions deploy payments
// Call at: https://<project>.supabase.co/functions/v1/payments<original-path>
// All uploads here (payment screenshots, <=10MB) are comfortably within the
// Edge Function memory ceiling, so unlike media.ts's video endpoints, these
// port over as-is with no redesign needed.
import { z } from "npm:zod@^3";
import { serve, type Handler } from "../_shared/serve.ts";
import { supabaseAdmin } from "../_shared/supabase-admin.ts";
import { isBackendAdmin } from "../_shared/admin.ts";
import { decodeUpload } from "../_shared/upload.ts";

async function assertPaymentAdmin(clerkUserId: string) {
  if (isBackendAdmin(clerkUserId)) return;
  const { data: profile } = await supabaseAdmin.from("profiles").select("is_admin").eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!profile?.is_admin) throw new Error("Access denied. Admin privileges required.");
}

const routes: Record<string, Handler> = {};

routes["/upload-payment-screenshot"] = async (body, clerkUserId) => {
  const data = z.object({ fileBase64: z.string().min(1), mimeType: z.enum(["image/jpeg", "image/png"]), fileName: z.string().min(1).max(255) }).parse(body);
  const buffer = decodeUpload(data.fileBase64, data.mimeType, 10 * 1024 * 1024, /^image\/(jpeg|png)$/);
  const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `payments/${clerkUserId}/${Date.now()}-${safeName}`;
  const { error } = await supabaseAdmin.storage.from("payment-screenshots").upload(storagePath, buffer, { contentType: data.mimeType, upsert: false });
  if (error) throw new Error(`Screenshot upload failed: ${error.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("payment-screenshots").getPublicUrl(storagePath);
  return { url: urlData.publicUrl };
};

routes["/submit-payment"] = async (body, clerkUserId) => {
  const data = z.object({ displayName: z.string().max(100).optional(), amount: z.number().positive(), currency: z.enum(["USD", "ZiG"]), transactionId: z.string().min(1).max(25), screenshotUrl: z.string().url().optional(), disputeNote: z.string().max(500).optional() }).parse(body);
  const normalizedTxId = data.transactionId.toUpperCase().trim();
  const { data: existing } = await supabaseAdmin.from("payments").select("id").eq("transaction_id", normalizedTxId).maybeSingle();
  if (existing) throw new Error("This transaction ID has already been submitted. If this is an error, use the dispute option.");
  const { data: payment, error } = await supabaseAdmin.from("payments").insert({ user_id: clerkUserId, user_display_name: data.displayName || null, amount: data.amount, currency: data.currency, transaction_id: normalizedTxId, status: "pending", screenshot_url: data.screenshotUrl || null, dispute_note: data.disputeNote || null }).select().single();
  if (error) throw new Error(error.message);
  return payment;
};

routes["/get-user-payments"] = async (_body, clerkUserId) => {
  const { data: rows, error } = await supabaseAdmin.from("payments").select("*").eq("user_id", clerkUserId).order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return rows || [];
};

routes["/get-admin-payments"] = async (body, clerkUserId) => {
  const data = z.object({ status: z.enum(["pending", "approved", "rejected"]).optional().default("pending") }).parse(body);
  await assertPaymentAdmin(clerkUserId);
  const { data: rows, error } = await supabaseAdmin.from("payments").select("*").eq("status", data.status).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return rows || [];
};

routes["/verify-order"] = async (body, clerkUserId) => {
  const data = z.object({ paymentId: z.string().uuid(), action: z.enum(["approved", "rejected"]), rejectionReason: z.string().max(500).optional() }).parse(body);
  await assertPaymentAdmin(clerkUserId);
  const { data: payment, error: fetchError } = await supabaseAdmin.from("payments").select("user_id, amount, currency").eq("id", data.paymentId).eq("status", "pending").maybeSingle();
  if (fetchError || !payment) throw new Error("Payment not found or already processed.");
  const { error } = await supabaseAdmin.from("payments").update({ status: data.action, approved_by: clerkUserId, processed_at: new Date().toISOString(), rejection_reason: data.rejectionReason || null }).eq("id", data.paymentId).eq("status", "pending");
  if (error) throw new Error(error.message);
  if (data.action === "approved") {
    let usdToZigRate = 13.5;
    if (payment.currency !== "USD") {
      const { data: settings } = await supabaseAdmin.from("ecocash_settings").select("usd_to_zig_rate").eq("id", 1).maybeSingle();
      if (settings?.usd_to_zig_rate) usdToZigRate = Number(settings.usd_to_zig_rate);
    }
    const amountUsd = payment.currency === "USD" ? Number(payment.amount) : Number(payment.amount) / usdToZigRate;
    await supabaseAdmin.from("profiles").update({ subscription_tier: amountUsd >= 9.99 ? "pro" : "premium" }).eq("clerk_user_id", payment.user_id);
  }
  return { success: true };
};

routes["/get-ecocash-settings"] = async () => {
  const { data, error } = await supabaseAdmin.from("ecocash_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data || { id: 1, usd_to_zig_rate: 13.5, ecocash_number: "0788800342" };
};

routes["/update-ecocash-settings"] = async (body, clerkUserId) => {
  const data = z.object({ usdToZigRate: z.number().positive(), ecocashNumber: z.string().min(3).max(40) }).parse(body);
  await assertPaymentAdmin(clerkUserId);
  const { error } = await supabaseAdmin.from("ecocash_settings").upsert({ id: 1, usd_to_zig_rate: data.usdToZigRate, ecocash_number: data.ecocashNumber, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
  return { success: true };
};

serve(routes);
