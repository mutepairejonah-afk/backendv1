import { Router } from "express";
import { profilesRouter } from "./profiles.js";
import { contactsRouter } from "./contacts.js";
import { conversationsRouter } from "./conversations.js";
import { messagesRouter } from "./messages.js";
import { groupsRouter } from "./groups.js";
import { momentsRouter } from "./moments.js";
import { storiesRouter } from "./stories.js";
import { callsRouter } from "./calls.js";
import { premiumRouter } from "./premium.js";
import { miscRouter } from "./misc.js";
import { channelsRouter } from "./channels.js";
import { supportRouter } from "./support.js";
import { securityRouter } from "./security.js";
import { operationsRouter } from "./operations.js";
import { spacesRouter } from "./spaces.js";
import { internalRouter } from "./internal.js";

// NOTE: ai.ts, agent.ts, media.ts, and payments.ts have moved to Supabase Edge
// Functions (see supabase/functions/ai, /media, /payments) to keep this
// Render service's compute footprint light. Their logic isn't deleted from
// history -- see the migration commit -- it's just no longer mounted here.
// internalRouter exists so those Edge Functions can still ask this process
// (the only place with live Socket.IO connections) to broadcast realtime
// events after they write to the database.

export const apiRouter = Router();

apiRouter.use(profilesRouter);
apiRouter.use(contactsRouter);
apiRouter.use(conversationsRouter);
apiRouter.use(messagesRouter);
apiRouter.use(groupsRouter);
apiRouter.use(momentsRouter);
apiRouter.use(storiesRouter);
apiRouter.use(callsRouter);
apiRouter.use(premiumRouter);
apiRouter.use(miscRouter);
apiRouter.use(channelsRouter);
apiRouter.use(supportRouter);
apiRouter.use(securityRouter);
apiRouter.use(operationsRouter);
apiRouter.use(spacesRouter);
apiRouter.use(internalRouter);
