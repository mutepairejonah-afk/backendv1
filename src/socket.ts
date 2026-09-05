import type { Server as HttpServer } from "node:http";
import { Server as IOServer, type Socket } from "socket.io";
import { verifyToken } from "@clerk/backend";
import { aiChatReply } from "./lib/ai.js";
import { supabaseAdmin } from "./lib/supabase.js";
import { checkRateLimit } from "./lib/rate-limit.js";

const pushTokens = new Map<string, string>();

async function sendExpoPush(opts: {
  token: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) {
  try {
    await fetch("https://exp.host/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        to: opts.token,
        title: opts.title,
        body: opts.body,
        data: opts.data ?? {},
        sound: "default",
        priority: "high",
        channelId: "messages",
      }),
    });
  } catch (e) {
    console.error("[push] failed:", e);
  }
}

if (typeof process !== "undefined") {
  process.on("uncaughtException", (err) => {
    console.error("[socket.io] uncaughtException (caught):", err?.message || err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[socket.io] unhandledRejection (caught):", reason);
  });
}

type ClientToServer = {
  auth: (clerkUserId: string) => void;
  "push:register": (data: { clerkUserId: string; token: string }) => void;
  "conv:join": (conversationId: string) => void;
  "conv:leave": (conversationId: string) => void;
  "message:sent": (data: { conversationId: string; message: any; participantIds?: string[]; senderName?: string }) => void;
  "message:edit": (data: { conversationId: string; messageId: string; newText: string; editedAt: string }) => void;
  "message:delete": (data: { conversationId: string; messageId: string }) => void;
  "read:receipt": (data: { conversationId: string; messageId: string; clerkUserId: string }) => void;
  typing: (data: { conversationId: string; clerkUserId: string; displayName: string }) => void;
  "typing:stop": (data: { conversationId: string; clerkUserId: string }) => void;
  "poll:vote": (data: { conversationId: string; pollId: string }) => void;
  "call:invite": (data: { toClerkId: string; fromClerkId: string; fromName: string; fromAvatar: string | null; conversationId: string; kind: "audio" | "video" }) => void;
  "call:accept": (data: { toClerkId: string; fromClerkId: string }) => void;
  "call:reject": (data: { toClerkId: string; fromClerkId: string }) => void;
  "call:end": (data: { toClerkId: string; fromClerkId: string }) => void;
  "call:signal": (data: { toClerkId: string; fromClerkId: string; signal: any }) => void;
  "ai:chat": (data: { clerkUserId: string; message: string; recentMessages: { sender: string; text: string }[] }) => void;
  "msg:react": (data: { conversationId: string; messageId: string; reactions: Record<string, string[]> }) => void;
};

type ServerToClient = {
  "message:new": (data: { conversationId: string; message: any }) => void;
  "message:edited": (data: { conversationId: string; messageId: string; newText: string; editedAt: string }) => void;
  "message:deleted": (data: { conversationId: string; messageId: string }) => void;
  "read:receipt": (data: { conversationId: string; messageId: string; clerkUserId: string }) => void;
  typing: (data: { conversationId: string; clerkUserId: string; displayName: string }) => void;
  "typing:stop": (data: { conversationId: string; clerkUserId: string }) => void;
  "presence:update": (data: { clerkUserId: string; online: boolean }) => void;
  "poll:voted": (data: { conversationId: string; pollId: string }) => void;
  "call:incoming": (data: { fromClerkId: string; fromName: string; fromAvatar: string | null; conversationId: string; kind: "audio" | "video" }) => void;
  "call:accepted": (data: { fromClerkId: string }) => void;
  "call:rejected": (data: { fromClerkId: string }) => void;
  "call:ended": (data: { fromClerkId: string }) => void;
  "call:signal": (data: { fromClerkId: string; signal: any }) => void;
  "ai:response": (data: { reply: string; error?: string }) => void;
  "msg:reaction": (data: { messageId: string; reactions: Record<string, string[]> }) => void;
};

interface SocketData { clerkUserId?: string; }
type AppSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

let io: IOServer<ClientToServer, ServerToClient, Record<string, never>, SocketData> | null = null;

const userRoom = (clerkId: string) => `user:${clerkId}`;
const convRoom = (convId: string) => `conv:${convId}`;
function safeEmit(fn: () => void) { try { fn(); } catch (e) { console.error("[socket.io] emit error:", e); } }
function relayToUser(_socket: AppSocket, toClerkId: string, event: keyof ServerToClient, payload: any) {
  if (!io) return;
  safeEmit(() => io!.to(userRoom(toClerkId)).emit(event, payload));
}

const IO_OPTS = {
  path: "/socket.io",
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"] as ("websocket" | "polling")[],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
};

export function attachSocketServer(httpServer: HttpServer): IOServer {
  if (io) { io.attach(httpServer, IO_OPTS); return io as unknown as IOServer; }

  io = new IOServer<ClientToServer, ServerToClient, Record<string, never>, SocketData>(httpServer, IO_OPTS);

  io.use(async (socket, next) => {
    const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : "";
    if (!token) return next(new Error("Unauthorized: missing Socket.IO token"));
    try {
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
      socket.data.clerkUserId = payload.sub;
      next();
    } catch {
      next(new Error("Unauthorized: invalid Socket.IO token"));
    }
  });

  io.on("connection", (socket: AppSocket) => {
    const allowEvent = (name: string, max = 60) => {
      const userId = socket.data.clerkUserId;
      return !!userId && checkRateLimit(`socket:${userId}:${name}`, max, 60_000);
    };
    const safe = <T extends any[]>(fn: (...args: T) => void) => (...args: T) => {
      try { fn(...args); } catch (e) { console.error("[socket.io] handler error:", e); }
    };

    socket.on("auth", safe((clerkUserId) => {
      if (!clerkUserId || typeof clerkUserId !== "string" || clerkUserId !== socket.data.clerkUserId) return;
      socket.join(userRoom(clerkUserId));
      socket.broadcast.emit("presence:update", { clerkUserId, online: true });
      // Persist to the DB too — a live socket broadcast alone is only seen by
      // whoever happens to be connected at that exact moment. Anyone opening
      // a chat later (or reloading) has nothing to fall back on unless this
      // is actually saved, which is what made "last seen" effectively dead.
      supabaseAdmin.from("profiles").update({ is_online: true }).eq("clerk_user_id", clerkUserId)
        .then(({ error }) => { if (error) console.error("[presence] failed to persist online state:", error.message); });
    }));

    socket.on("push:register", safe(({ clerkUserId, token }) => {
      if (!clerkUserId || !token) return;
      pushTokens.set(clerkUserId, token);
    }));

    socket.on("conv:join", async (conversationId) => {
      if (!allowEvent("conv:join") || typeof conversationId !== "string") return;
      try {
        const { data: membership } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", conversationId).eq("clerk_user_id", socket.data.clerkUserId).maybeSingle();
        if (membership) socket.join(convRoom(conversationId));
      } catch (e) { console.error("[socket.io] room authorization failed:", e); }
    });
    socket.on("conv:leave", safe((conversationId) => { if (allowEvent("conv:leave") && typeof conversationId === "string") socket.leave(convRoom(conversationId)); }));

    socket.on("message:sent", safe(({ conversationId, message, participantIds, senderName }) => {
      if (!allowEvent("message:sent", 30)) return;
      if (!conversationId || !message) return;
      socket.to(convRoom(conversationId)).emit("message:new", { conversationId, message });
      if (Array.isArray(participantIds)) {
        const senderClerkId = socket.data.clerkUserId;
        for (const clerkId of participantIds) {
          io?.to(userRoom(clerkId)).emit("message:new", { conversationId, message });
          if (clerkId !== senderClerkId) {
            const token = pushTokens.get(clerkId);
            if (token) {
              const body = message.text ? message.text.slice(0, 100)
                : message.image_url ? "📷 Photo"
                : message.file_name ? `📎 ${message.file_name}`
                : message.file_url?.includes("audio") ? "🎤 Voice message"
                : "New message";
              sendExpoPush({ token, title: senderName || "New message", body, data: { conversationId } });
            }
          }
        }
      }
    }));

    socket.on("message:edit", safe(({ conversationId, messageId, newText, editedAt }) => {
      socket.to(convRoom(conversationId)).emit("message:edited", { conversationId, messageId, newText, editedAt });
    }));

    socket.on("message:delete", safe(({ conversationId, messageId }) => {
      socket.to(convRoom(conversationId)).emit("message:deleted", { conversationId, messageId });
    }));

    socket.on("read:receipt", safe(({ conversationId, messageId, clerkUserId }) => {
      socket.to(convRoom(conversationId)).emit("read:receipt", { conversationId, messageId, clerkUserId });
    }));

    socket.on("typing", safe(({ conversationId, clerkUserId, displayName }) => {
      socket.to(convRoom(conversationId)).emit("typing", { conversationId, clerkUserId, displayName: displayName || "Someone" });
    }));

    socket.on("typing:stop", safe(({ conversationId, clerkUserId }) => {
      socket.to(convRoom(conversationId)).emit("typing:stop", { conversationId, clerkUserId });
    }));

    socket.on("poll:vote", safe(({ conversationId, pollId }) => {
      socket.to(convRoom(conversationId)).emit("poll:voted", { conversationId, pollId });
    }));

    socket.on("call:invite", safe((data) => {
      if (!allowEvent("call:invite", 5) || !data?.toClerkId || !socket.data.clerkUserId) return;
      relayToUser(socket, data.toClerkId, "call:incoming", { fromClerkId: socket.data.clerkUserId, fromName: data.fromName, fromAvatar: data.fromAvatar, conversationId: data.conversationId, kind: data.kind });
    }));

    socket.on("call:accept", safe((data) => { if (!allowEvent("call:accept", 10) || !data?.toClerkId || !socket.data.clerkUserId) return; relayToUser(socket, data.toClerkId, "call:accepted", { fromClerkId: socket.data.clerkUserId }); }));
    socket.on("call:reject", safe((data) => { if (!allowEvent("call:reject", 10) || !data?.toClerkId || !socket.data.clerkUserId) return; relayToUser(socket, data.toClerkId, "call:rejected", { fromClerkId: socket.data.clerkUserId }); }));
    socket.on("call:end", safe((data) => { if (!allowEvent("call:end", 10) || !data?.toClerkId || !socket.data.clerkUserId) return; relayToUser(socket, data.toClerkId, "call:ended", { fromClerkId: socket.data.clerkUserId }); }));
    socket.on("call:signal", safe((data) => { if (!allowEvent("call:signal", 120) || !data?.toClerkId || !socket.data.clerkUserId) return; relayToUser(socket, data.toClerkId, "call:signal", { fromClerkId: socket.data.clerkUserId, signal: data.signal }); }));

    socket.on("msg:react", safe((data) => {
      if (!data?.conversationId || !data?.messageId) return;
      socket.to(convRoom(data.conversationId)).emit("msg:reaction", { messageId: data.messageId, reactions: data.reactions });
    }));

    socket.on("ai:chat", safe(async (data) => {
      if (!data?.message || !data?.clerkUserId) return;
      try {
        const reply = await aiChatReply(data.message, data.recentMessages || [], "free");
        socket.emit("ai:response", { reply });
      } catch (err: any) {
        socket.emit("ai:response", { reply: "", error: err?.message || "AI error" });
      }
    }));

    socket.on("disconnect", safe(() => {
      const clerkId = socket.data.clerkUserId;
      if (clerkId) {
        const room = io?.sockets.adapter.rooms.get(userRoom(clerkId));
        if (!room || room.size === 0) {
          socket.broadcast.emit("presence:update", { clerkUserId: clerkId, online: false });
          // Persist offline + last_seen so a reconnecting/reloading client
          // (or one that was never connected while this user was online)
          // has accurate data instead of a stale "online forever" state.
          // This also covers app kills/crashes, which never fire a clean
          // "going offline" API call from the client.
          const disconnectedAt = new Date().toISOString();
          supabaseAdmin.from("profiles").update({ is_online: false, last_seen: disconnectedAt }).eq("clerk_user_id", clerkId)
            .then(({ error }) => { if (error) console.error("[presence] failed to persist offline state:", error.message); });
        }
      }
    }));

    socket.on("error", (err) => { console.error("[socket.io] socket error:", err?.message || err); });
  });

  io.on("error", (err) => { console.error("[socket.io] server error:", err?.message || err); });
  return io as unknown as IOServer;
}

export function getIO() { return io; }
