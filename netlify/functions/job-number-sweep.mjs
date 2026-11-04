// Hourly backup: catches any new deal the webhook missed.
// Goes in: netlify/functions/job-number-sweep.mjs

import { sweep } from "../lib/jobnumber.mjs";

export default async () => {
  const results = await sweep();
  console.log("sweep assigned", results);
};

export const config = { schedule: "@hourly" };
