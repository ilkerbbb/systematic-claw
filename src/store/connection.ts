/**
 * Database connection management for systematic-claw.
 * Uses node:sqlite (Node.js built-in DatabaseSync) — same pattern as lossless-claw.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type ConnectionEntry = {
  db: DatabaseSync;
  refs: number;
};

const _connections = new Map<string, ConnectionEntry>();

function isConnectionHealthy(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

function forceClose(entry: ConnectionEntry): void {
  try {
    entry.db.close();
  } catch {
    // Ignore close failures
  }
}

export function getConnection(dbPath: string): DatabaseSync {
  const existing = _connections.get(dbPath);
  if (existing) {
    if (isConnectionHealthy(existing.db)) {
      existing.refs += 1;
      return existing.db;
    }
    forceClose(existing);
    _connections.delete(dbPath);
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  _connections.set(dbPath, { db, refs: 1 });
  return db;
}

export function closeConnection(dbPath?: string): void {
  if (typeof dbPath === "string" && dbPath.trim()) {
    const entry = _connections.get(dbPath);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      forceClose(entry);
      _connections.delete(dbPath);
    }
    return;
  }
  for (const entry of _connections.values()) {
    forceClose(entry);
  }
  _connections.clear();
}
