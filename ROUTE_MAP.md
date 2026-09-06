# Reach backend route map

Generated from the current checked-out backend source.

## Connection flow

```text
HTTP request -> src/index.ts -> CORS/body limits/rate limit -> /api -> src/routes/index.ts -> feature router -> Clerk auth -> Zod validation -> Supabase/provider operation -> JSON response
Socket.IO request -> same HTTP server -> src/socket.ts -> Clerk token handshake -> authenticated socket event -> user/conversation room relay
```

## Direct mounts

- `GET /health` and `GET /ready` are registered directly in `src/index.ts`.
- `POST /webhooks/clerk` is mounted from `src/routes/webhooks.ts` before JSON parsing for Svix signature verification.
- All feature REST routers are mounted under `/api` in `src/routes/index.ts`.
- Socket.IO uses the same origin at `/socket.io`.

## REST route inventory

### agent.ts

- POST /ai/agent — source line 18

### ai.ts

- POST /ai/conversation-brief — source line 77
- POST /ai/draft-reply — source line 142
- POST /ai/review-message — source line 156
- POST /ai-chat-assist — source line 167
- POST /translate-message — source line 178
- POST /ai-summarize-unread — source line 185
- POST /ai-draft-order-reply — source line 195
- POST /ai-summarize-call — source line 202
- POST /ai/smart-replies — source line 210
- POST /ai/action-items — source line 228
- POST /ai/channel-description — source line 245

### calls.ts

- POST /log-call — source line 16
- POST /get-call-history — source line 24
- POST /delete-call-log — source line 38
- POST /clear-call-history — source line 45
- POST /get-ice-servers — source line 52

### channels.ts

- POST /create-channel — source line 41
- POST /update-channel-settings — source line 63
- POST /regenerate-channel-invite — source line 78
- POST /preview-channel-by-invite — source line 91
- POST /join-channel-by-invite — source line 100
- POST /get-channels — source line 109
- POST /join-channel — source line 119
- POST /leave-channel — source line 128
- POST /add-channel-member — source line 135
- POST /remove-channel-member — source line 145
- POST /archive-channel — source line 155
- POST /get-channel-info — source line 166
- POST /mark-channel-read — source line 188
- POST /discover-channels — source line 195
- POST /get-followed-channels — source line 208
- POST /follow-channel — source line 219
- POST /unfollow-channel — source line 227
- POST /get-channel-feed — source line 237

### contacts.ts

- POST /get-contacts — source line 16
- POST /add-contact — source line 25
- POST /remove-contact — source line 49
- POST /is-contact — source line 56
- POST /get-pending-requests — source line 62
- POST /get-outgoing-requests — source line 71
- POST /accept-contact-request — source line 80
- POST /reject-contact-request — source line 89
- POST /get-notification-count — source line 96
- POST /get-friend-suggestions — source line 104

### conversations.ts

- POST /get-conversations — source line 16
- POST /get-or-create-direct-conversation — source line 50
- POST /mark-conversation-read — source line 73
- POST /clear-chat — source line 83
- POST /delete-chat-for-me — source line 97
- POST /create-group-conversation — source line 107
- POST /get-conversation-details — source line 116
- POST /get-conversation-media — source line 126
- POST /sweep-expired-messages — source line 132
- POST /get-conversation-wallpaper — source line 138
- POST /set-conversation-wallpaper — source line 144
- POST /export-chat-history — source line 151

### groups.ts

- POST /create-group — source line 29
- POST /get-group-info — source line 39
- POST /update-group-info — source line 55
- POST /update-group-permissions — source line 72
- POST /set-group-member-role — source line 84
- POST /add-group-member — source line 96
- POST /remove-group-member — source line 110
- POST /leave-group — source line 123
- POST /generate-invite-code — source line 132
- POST /lookup-invite — source line 147
- POST /join-group-by-invite — source line 155
- POST /upload-group-avatar — source line 166
- POST /set-conversation-mute — source line 185

### media.ts

- POST /upload-chat-media — source line 26
- POST /upload-document-message — source line 61
- POST /upload-avatar — source line 81
- POST /upload-moment-image — source line 93

### messages.ts

- POST /get-messages — source line 26
- POST /send-message — source line 54
- POST /edit-message — source line 69
- POST /delete-message-for-everyone — source line 79
- POST /delete-message-for-me — source line 94
- POST /add-reaction — source line 105
- POST /mark-messages-read — source line 113
- POST /get-read-receipts — source line 120
- POST /toggle-pin-message — source line 126
- POST /get-pinned-messages — source line 142
- POST /toggle-star-message — source line 148
- POST /get-starred-messages — source line 156
- POST /create-poll — source line 175
- POST /get-poll — source line 190
- POST /vote-poll — source line 199
- POST /schedule-message — source line 213
- POST /get-scheduled-messages — source line 220
- POST /cancel-scheduled-message — source line 226
- POST /send-location-message — source line 234
- POST /send-contact-message — source line 245

### misc.ts

- POST /block-user — source line 17
- POST /unblock-user — source line 26
- POST /get-blocked-users — source line 32
- POST /is-blocked — source line 41
- POST /report-target — source line 47
- POST /get-setup-status — source line 57

### moments.ts

- POST /get-moments — source line 16
- POST /create-moment — source line 33
- POST /toggle-moment-like — source line 41
- POST /get-moment-comments — source line 49
- POST /add-moment-comment — source line 59
- POST /delete-moment — source line 66
- POST /delete-moment-comment — source line 76

### premium.ts

- POST /get-premium-status — source line 16
- POST /upgrade-plan — source line 27
- POST /update-privacy-settings — source line 34
- POST /update-bio-links — source line 43
- POST /get-is-admin — source line 50

### profiles.ts

- POST /get-or-create-profile — source line 16
- POST /update-profile — source line 36
- POST /get-all-profiles — source line 59
- POST /check-username-availability — source line 66
- POST /claim-username — source line 77
- POST /get-profile-by-username — source line 89
- POST /get-profile-by-clerk-id — source line 95
- POST /search-profiles-by-username — source line 101

### security.ts

- POST /get-security-settings — source line 19
- POST /update-security-settings — source line 25
- POST /register-session — source line 46
- POST /get-my-sessions — source line 72
- POST /revoke-session — source line 78
- POST /get-security-events — source line 92

### support.ts

- POST /saved-items/create — source line 28
- POST /saved-items/list — source line 53
- POST /saved-items/delete — source line 64
- POST /search-messages — source line 72

### webhooks.ts

- POST /clerk — source line 19

## Socket.IO inbound events

- `auth` — source line 131
- `push:register` — source line 143
- `conv:join` — source line 148
- `conv:leave` — source line 155
- `message:sent` — source line 157
- `message:edit` — source line 180
- `message:delete` — source line 184
- `read:receipt` — source line 188
- `typing` — source line 192
- `typing:stop` — source line 196
- `poll:vote` — source line 200
- `call:invite` — source line 204
- `call:accept` — source line 209
- `call:reject` — source line 210
- `call:end` — source line 211
- `call:signal` — source line 212
- `msg:react` — source line 214
- `ai:chat` — source line 219
- `disconnect` — source line 229
- `error` — source line 247

## Authentication note

All API feature routes are protected by `requireAuth` except the Clerk webhook, which uses webhook signature verification. Clients send `Authorization: Bearer <Clerk session token>`.
