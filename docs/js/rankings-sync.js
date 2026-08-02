import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isSyncConfigured,
} from "./sync-config.js";

let client = null;
const SAVE_DEBOUNCE_MS = 600;

function getClient() {
  if (!isSyncConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

async function getSession() {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  return data.session || null;
}

async function getUser() {
  const session = await getSession();
  return session?.user || null;
}

/**
 * @param {(session: object|null) => void} callback
 */
function onAuthChange(callback) {
  const sb = getClient();
  if (!sb) {
    callback(null);
    return { data: { subscription: { unsubscribe() {} } } };
  }
  return sb.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}

async function signInWithEmail(email) {
  const sb = getClient();
  if (!sb) throw new Error("Sync is not configured");
  const redirectTo = window.location.href.split("#")[0];
  const { error } = await sb.auth.signInWithOtp({
    email: String(email || "").trim(),
    options: { emailRedirectTo: redirectTo },
  });
  if (error) throw error;
}

async function signOut() {
  const sb = getClient();
  if (!sb) return;
  const { error } = await sb.auth.signOut();
  if (error) throw error;
}

/**
 * @param {string} position
 * @returns {Promise<{orders: object, tier_breaks: object, updated_at: string}|null>}
 */
async function fetchBoard(position) {
  const sb = getClient();
  const user = await getUser();
  if (!sb || !user) return null;

  const { data, error } = await sb
    .from("ranking_boards")
    .select("orders, tier_breaks, updated_at")
    .eq("user_id", user.id)
    .eq("position", String(position).toUpperCase())
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return {
    orders: data.orders || {},
    tier_breaks: data.tier_breaks || {},
    updated_at: data.updated_at,
  };
}

/**
 * @param {object} board
 * @param {string} board.position
 * @param {object} board.orders
 * @param {object} board.tier_breaks
 * @param {string} [board.updated_at]
 */
async function saveBoard(board) {
  const sb = getClient();
  const user = await getUser();
  if (!sb || !user) return false;

  const updatedAt = board.updated_at || new Date().toISOString();
  const { error } = await sb.from("ranking_boards").upsert(
    {
      user_id: user.id,
      position: String(board.position).toUpperCase(),
      orders: board.orders,
      tier_breaks: board.tier_breaks,
      updated_at: updatedAt,
    },
    { onConflict: "user_id,position" }
  );
  if (error) throw error;
  return true;
}

/**
 * @param {{ onSuccess?: () => void, onError?: (err: Error) => void }} [hooks]
 */
function createDebouncedSaver(hooks = {}) {
  let timer = null;
  let pending = null;
  let inFlight = Promise.resolve();

  async function write(payload) {
    try {
      await saveBoard(payload);
      hooks.onSuccess?.();
    } catch (err) {
      console.error("Failed to sync rankings", err);
      hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  return {
    schedule(board) {
      pending = board;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const payload = pending;
        pending = null;
        inFlight = inFlight.then(() => write(payload)).catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    },
    async flush() {
      clearTimeout(timer);
      if (pending) {
        const payload = pending;
        pending = null;
        await write(payload);
      }
      await inFlight;
    },
  };
}

function tsValue(iso) {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Prefer the newer of local vs remote board payloads.
 * @returns {{source: 'remote'|'local'|'none', board: object|null}}
 */
function pickNewerBoard(localBoard, remoteBoard) {
  if (!localBoard && !remoteBoard) return { source: "none", board: null };
  if (!localBoard) return { source: "remote", board: remoteBoard };
  if (!remoteBoard) return { source: "local", board: localBoard };
  if (tsValue(remoteBoard.updated_at) >= tsValue(localBoard.updated_at)) {
    return { source: "remote", board: remoteBoard };
  }
  return { source: "local", board: localBoard };
}

export {
  isSyncConfigured,
  getClient,
  getSession,
  getUser,
  onAuthChange,
  signInWithEmail,
  signOut,
  fetchBoard,
  saveBoard,
  createDebouncedSaver,
  pickNewerBoard,
};
