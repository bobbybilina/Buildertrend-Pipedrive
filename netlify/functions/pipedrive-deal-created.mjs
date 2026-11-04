// Instant webhook: Pipedrive calls this the moment a deal is created.
// Goes in: netlify/functions/pipedrive-deal-created.mjs
// URL: https://YOUR-SITE.netlify.app/hooks/pipedrive-deal-created

import { assignJobNumber } from "../lib/jobnumber.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("ok");

  // Only accept calls carrying the username/password you set on the Pipedrive webhook
  const expected =
    "Basic " +
    Buffer.from(`${process.env.WEBHOOK_USER}:${process.env.WEBHOOK_PASS}`).toString("base64");
  if (req.headers.get("authorization") !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const meta = body.meta || {};
  const entity = meta.entity || meta.object; // v2 || v1 webhook format
  if (entity !== "deal" || !["create", "added"].includes(meta.action)) {
    return new Response("ignored");
  }

  const dealId = body.data?.id ?? body.current?.id ?? meta.entity_id ?? meta.id;
  if (!dealId) return new Response("no deal id", { status: 400 });

  try {
    const result = await assignJobNumber(dealId);
    console.log("job number", result);
    return Response.json(result);
  } catch (err) {
    console.error(err);
    return new Response("error", { status: 500 }); // Pipedrive will retry; safe to repeat
  }
};

export const config = { path: "/hooks/pipedrive-deal-created" };
