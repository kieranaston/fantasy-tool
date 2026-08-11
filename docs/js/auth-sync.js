/**
 * Supabase auth + favourites sync.
 * Favourites are stored per signed-in user and also cached in localStorage.
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isSyncConfigured,
} from "./sync-config.js";

let client = null;
const SAVE_DEBOUNCE_MS = 400;

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
 * Subscribe to auth changes.
 * Callback is invoked asynchronously (never directly inside the Supabase
 * auth listener) so we don't deadlock by calling getSession from it.
 * @param {(event: string, session: object|null) => void} callback
 */
function onAuthChange(callback) {
  const sb = getClient();
  if (!sb) {
    queueMicrotask(() => callback("SIGNED_OUT", null));
    return { data: { subscription: { unsubscribe() {} } } };
  }
  return sb.auth.onAuthStateChange((event, session) => {
    queueMicrotask(() => callback(event, session));
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

function tsValue(iso) {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * @returns {Promise<{ids: string[], updated_at: string}|null>}
 */
async function fetchStars() {
  const sb = getClient();
  const user = await getUser();
  if (!sb || !user) return null;

  const { data, error } = await sb
    .from("starred_players")
    .select("ids, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const rawIds = data.ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.map(String).filter(Boolean)
    : typeof rawIds === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(rawIds);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
          } catch {
            return [];
          }
        })()
      : [];
  return { ids, updated_at: data.updated_at };
}

/**
 * @param {{ ids: string[]|Set<string>, updated_at?: string }} payload
 */
async function saveStars(payload) {
  const sb = getClient();
  const user = await getUser();
  if (!sb || !user) return false;

  const ids = [...(payload.ids || [])].map(String).filter(Boolean);
  const updatedAt = payload.updated_at || new Date().toISOString();
  const { error } = await sb.from("starred_players").upsert(
    {
      user_id: user.id,
      ids,
      updated_at: updatedAt,
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
  return true;
}

/**
 * Prefer the newer of local vs remote favourites payloads.
 * Ties go to local so in-flight remote fetches can't clobber a just-made toggle.
 * @returns {{source: 'remote'|'local'|'none', state: {ids: string[], updated_at: string|null}|null}}
 */
function pickNewerStars(localState, remoteState) {
  if (!localState && !remoteState) return { source: "none", state: null };
  if (!remoteState) return { source: "local", state: localState || null };
  if (!localState) return { source: "remote", state: remoteState };

  const localTs = tsValue(localState.updated_at);
  const remoteTs = tsValue(remoteState.updated_at);
  const localCount = localState.ids?.length || 0;
  const remoteCount = remoteState.ids?.length || 0;

  // Empty local + any remote row (including empty) → take remote on first sign-in.
  if (!localCount && remoteState) {
    return { source: "remote", state: remoteState };
  }

  // Strictly newer remote wins; equal or older → local (protects rapid toggles).
  if (remoteTs > localTs) {
    return { source: "remote", state: remoteState };
  }
  if (localTs > remoteTs) {
    return { source: "local", state: localState };
  }
  // Same timestamp: prefer whichever has ids if the other is empty; else local.
  if (localCount && !remoteCount) return { source: "local", state: localState };
  if (remoteCount && !localCount) return { source: "remote", state: remoteState };
  return { source: "local", state: localState };
}

/**
 * @param {{ onSuccess?: () => void, onError?: (err: Error) => void }} [hooks]
 */
function createDebouncedStarSaver(hooks = {}) {
  let timer = null;
  let pending = null;
  let inFlight = Promise.resolve();

  async function write(payload) {
    try {
      await saveStars(payload);
      hooks.onSuccess?.();
    } catch (err) {
      console.error("Failed to sync favourites", err);
      hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  return {
    schedule(payload) {
      pending = payload;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = pending;
        pending = null;
        inFlight = inFlight.then(() => write(next)).catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    },
    async flush() {
      clearTimeout(timer);
      if (pending) {
        const next = pending;
        pending = null;
        await write(next);
      }
      await inFlight;
    },
  };
}

export {
  isSyncConfigured,
  getClient,
  getSession,
  getUser,
  onAuthChange,
  signInWithEmail,
  signOut,
  fetchStars,
  saveStars,
  pickNewerStars,
  createDebouncedStarSaver,
};
