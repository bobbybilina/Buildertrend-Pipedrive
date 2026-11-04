// Sorox job numbers (SB-####) for Pipedrive deals.
// Numbers come from a saved counter (Netlify Blobs) that only ever moves forward.
//
// Settings (Netlify environment variables):
//   PIPEDRIVE_API_TOKEN  - required
//   START_NUMBER         - first number to hand out, e.g. 1300 (optional)
//   JOB_PREFIX           - defaults to "SB-"

import { getStore } from "@netlify/blobs";

const API = "https://api.pipedrive.com/api/v2";
const SB_FIELD = "c9ca265c02adc4099f30d861bb68223db75e085b"; // "JOB NUMBER"
const PREFIX = process.env.JOB_PREFIX || "SB-";
const COUNTER_KEY = "last-issued";

async function pd(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      "x-api-token": process.env.PIPEDRIVE_API_TOKEN,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`Pipedrive ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

function num(v) {
  const m = String(v ?? "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Highest SB number already on any deal - only used the very first time,
// so a start number can never collide with numbers already handed out.
async function highestInPipedrive() {
  let max = 0;
  let cursor;
  do {
    const qs = new URLSearchParams({
      limit: "500",
      custom_fields: SB_FIELD,
      status: "open,won,lost,deleted",
    });
    if (cursor) qs.set("cursor", cursor);
    const b = await pd(`/deals?${qs}`);
    for (const d of b.data || []) max = Math.max(max, num(d.custom_fields?.[SB_FIELD]));
    cursor = b.additional_data?.next_cursor;
  } while (cursor);
  return max;
}

// Reserve the next number. Safe if two deals arrive at the same moment:
// the write only succeeds if nobody else changed the counter in between.
export async function nextNumber(store = getStore({ name: "job-numbers", consistency: "strong" })) {
  const floor = Math.max(0, num(process.env.START_NUMBER) - 1);
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await store.getWithMetadata(COUNTER_KEY, { type: "json" });
    let last;
    if (current) {
      last = Math.max(current.data.last, floor); // a higher START_NUMBER jumps ahead; lower is ignored
    } else {
      last = Math.max(floor, await highestInPipedrive());
    }
    const next = last + 1;
    const write = current
      ? await store.setJSON(COUNTER_KEY, { last: next }, { onlyIfMatch: current.etag })
      : await store.setJSON(COUNTER_KEY, { last: next }, { onlyIfNew: true });
    if (write.modified) return next;
  }
  throw new Error("Could not reserve a job number - counter busy");
}

async function setNumber(dealId, value) {
  await pd(`/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ custom_fields: { [SB_FIELD]: value } }),
  });
}

// Webhook: number one new deal right away.
export async function assignJobNumber(dealId) {
  const { data: deal } = await pd(`/deals/${dealId}?custom_fields=${SB_FIELD}`);
  if (deal.custom_fields?.[SB_FIELD]) {
    return { dealId, skipped: true, value: deal.custom_fields[SB_FIELD] };
  }
  const value = PREFIX + (await nextNumber());
  await setNumber(dealId, value);
  return { dealId, value };
}

// Hourly backup: numbers any deal from the last 2 days the webhook missed.
export async function sweep() {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const missing = [];
  let cursor;
  do {
    const qs = new URLSearchParams({
      limit: "500",
      custom_fields: SB_FIELD,
      updated_since: cutoff.replace(/\.\d+Z$/, "Z"),
      sort_by: "add_time",
      sort_direction: "asc",
    });
    if (cursor) qs.set("cursor", cursor);
    const b = await pd(`/deals?${qs}`);
    for (const d of b.data || []) {
      if (!d.custom_fields?.[SB_FIELD] && d.add_time >= cutoff) missing.push(d);
    }
    cursor = b.additional_data?.next_cursor;
  } while (cursor);

  const results = [];
  for (const d of missing) results.push(await assignJobNumber(d.id));
  return results;
}
