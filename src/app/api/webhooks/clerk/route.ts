import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { handleClerkWebhookRequest, type ClerkEvent } from "@/lib/clerk-webhook";
import { neonExecutor } from "@/lib/neon-executor";

// Clerk's user events keep the teachers row in step (see
// src/lib/clerk-webhook.ts). Public in src/proxy.ts: Clerk calls it
// without a session, and the signature is the check.
export async function POST(request: NextRequest): Promise<Response> {
  return handleClerkWebhookRequest(request, {
    secret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    verify: (req, signingSecret) => verifyWebhook(req as NextRequest, { signingSecret }) as Promise<ClerkEvent>,
    execute: neonExecutor,
    log: (level, message, fields) => (level === "error" ? console.error : console.info)(message, fields ?? {}),
  });
}
