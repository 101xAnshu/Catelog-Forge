import { getDb, type DbHandle } from "@cf/db";

export function wdb(): DbHandle {
  return getDb("worker");
}
