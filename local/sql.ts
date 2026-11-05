/* eslint-disable @typescript-eslint/no-explicit-any */
/** Usage: tsx local/sql.ts "SELECT ..." [params as JSON array] — runs read SQL against dev D1. */
import { makeLocalEnv } from "./env.js";
const env = makeLocalEnv();
const params = process.argv[3] ? JSON.parse(process.argv[3]) : [];
const r: any = await env.DB.prepare(process.argv[2]).bind(...params).all();
console.log(JSON.stringify(r.results, null, 1));
