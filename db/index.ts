import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

type D1Binding = Parameters<typeof drizzle>[0];

export function getDb(binding: D1Binding) {
  if (!binding) throw new Error("Cloudflare D1 binding is unavailable.");
  return drizzle(binding, { schema });
}
