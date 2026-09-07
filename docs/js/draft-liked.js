/**
 * Favourites: per-user localStorage + optional email sync via Supabase.
 * Signed-out UI shows no stars. Account switches load that user's list only.
 * Last write wins within a user. A star tapped during a cloud fetch is kept.
 */

import { escapeHtml } from "./shared.js";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isSyncConfigured,
} from "./sync-config.js";

/** Legacy single-bucket key (pre per-user scoping). */
const LS_KEY_LEGACY = "draft-companion:liked";
const LS_KEY_GUEST = "draft-companion:liked:guest";
const LS_KEY_PREFIX = "draft-companion:liked:user:";
const SAVE_MS = 400;
const SB_SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

function storageKey(userId) {
  return userId ? `${LS_KEY_PREFIX}${userId}` : LS_KEY_GUEST;
}

function normalizeIds(ids) {
  const list = ids == null ? [] : Array.isArray(ids) ? ids : [...ids];
  return [...new Set(list.map(String).filter(Boolean))];
}

function readKey(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return {
      ids: Array.isArray(parsed?.ids) ? normalizeIds(parsed.ids) : [],
      updated_at: parsed?.updated_at || null,
    };
  } catch {
    return { ids: [], updated_at: null };
  }
}

function loadState(userId) {
  const key = storageKey(userId);
  const state = readKey(key);
  if (userId || state.ids.length || state.updated_at) return state;
  // One-time: adopt legacy guest bucket into the guest key.
  const legacy = readKey(LS_KEY_LEGACY);
  if (legacy.ids.length || legacy.updated_at) {
    saveState(null, legacy.ids, legacy.updated_at || new Date().toISOString());
    try {
      localStorage.removeItem(LS_KEY_LEGACY);
    } catch {
      /* ignore */
    }
    return loadState(null);
  }
  return state;
}

function saveState(userId, ids, updatedAt = new Date().toISOString()) {
  const state = { ids: normalizeIds(ids), updated_at: updatedAt };
  localStorage.setItem(storageKey(userId), JSON.stringify(state));
  return state;
}

function ts(iso) {
  const n = Date.parse(iso || "");
  return Number.isNaN(n) ? 0 : n;
}

let client = null;

function hasStoredSession() {
  try {
    return Object.keys(localStorage).some(
      (k) => k.startsWith("sb-") && k.includes("auth-token")
    );
  } catch {
    return false;
  }
}

async function getClient() {
  if (!isSyncConfigured()) return null;
  if (!client) {
    const { createClient } = await import(SB_SDK);
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

/**
 * @param {{
 *   host?: HTMLElement|null,
 *   onChange?: () => void,
 * }} options
 */
export function createFavourites(options = {}) {
  const { host, onChange } = options;
  let userId = null;
  let ids = new Set();
  let email = null;
  /** True if the user starred/unstarred since the last cloud apply. */
  let dirty = false;
  let status = "";
  let pending = null;
  let timer = null;
  let writing = Promise.resolve();

  function setStatus(text) {
    status = text || "";
    const el = host?.querySelector?.("[data-sync-status]");
    if (!el) return;
    el.textContent = status;
    el.hidden = !status;
  }

  function applyLocalIds(nextIds, updatedAt) {
    ids = new Set(normalizeIds(nextIds));
    saveState(userId, ids, updatedAt);
  }

  function clearFavourites() {
    dirty = false;
    pending = null;
    clearTimeout(timer);
    ids = new Set();
    onChange?.();
  }

  async function currentUser() {
    const sb = await getClient();
    if (!sb) return null;
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data.session?.user || null;
  }

  let authListenerBound = false;
  async function ensureAuthListener() {
    const sb = await getClient();
    if (!sb || authListenerBound) return sb;
    authListenerBound = true;
    sb.auth.onAuthStateChange((event, session) => {
      queueMicrotask(async () => {
        if (event === "INITIAL_SESSION") return;
        const nextUser = session?.user || null;
        const nextEmail = nextUser?.email || null;
        const nextId = nextUser?.id || null;

        if (event === "SIGNED_OUT" || !nextUser) {
          userId = null;
          email = null;
          clearFavourites();
          setStatus("");
          renderBar();
          return;
        }

        if (nextId !== userId || event === "SIGNED_IN") {
          userId = nextId;
          email = nextEmail;
          dirty = false;
          // Load only this user's bucket — never carry another account's stars.
          const local = loadState(userId);
          ids = new Set(local.ids);
          onChange?.();
          renderBar();
          try {
            await applyRemote();
          } catch (err) {
            setStatus(err.message || "Sync failed");
          }
          renderBar();
        } else if (nextEmail) {
          email = nextEmail;
        }
      });
    });
    return sb;
  }

  async function fetchRemote() {
    const sb = await getClient();
    const user = await currentUser();
    if (!sb || !user) return null;
    const { data, error } = await sb
      .from("starred_players")
      .select("ids, updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const raw = data.ids;
    return {
      ids: Array.isArray(raw) ? raw.map(String).filter(Boolean) : [],
      updated_at: data.updated_at,
    };
  }

  async function writeRemote(state) {
    const sb = await getClient();
    const user = await currentUser();
    if (!sb || !user) return;
    const { error } = await sb.from("starred_players").upsert(
      {
        user_id: user.id,
        ids: state.ids,
        updated_at: state.updated_at,
      },
      { onConflict: "user_id" }
    );
    if (error) throw error;
  }

  function schedulePush() {
    if (!email || !userId) return;
    pending = loadState(userId);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = pending;
      pending = null;
      writing = writing
        .then(() => writeRemote(next))
        .then(() => setStatus(""))
        .catch((err) => {
          setStatus(err.message || "Favourites sync failed");
        });
    }, SAVE_MS);
  }

  async function flush() {
    clearTimeout(timer);
    if (pending && userId) {
      const next = pending;
      pending = null;
      await writeRemote(next);
    }
    await writing;
  }

  async function applyRemote() {
    if (!userId || !email) return;
    if (dirty) {
      dirty = false;
      schedulePush();
      return;
    }
    const remote = await fetchRemote();
    if (dirty) {
      dirty = false;
      schedulePush();
      return;
    }
    const local = loadState(userId);
    if (remote && ts(remote.updated_at) > ts(local.updated_at)) {
      applyLocalIds(remote.ids, remote.updated_at);
      onChange?.();
      setStatus("");
    } else if (local.ids.length) {
      // Push this user's local only — never another account's leftover stars.
      schedulePush();
      setStatus("");
    } else if (remote) {
      applyLocalIds(remote.ids, remote.updated_at || new Date().toISOString());
      onChange?.();
      setStatus("");
    } else {
      setStatus("");
    }
  }

  function renderBar() {
    if (!host) return;
    if (!isSyncConfigured()) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.classList.add("sync-bar");
    host.hidden = false;
    if (email) {
      host.innerHTML = `
        <span class="sync-user">${escapeHtml(email)}</span>
        <button type="button" class="draft-btn" data-sync-signout>Sign out</button>
        <span class="sync-status" data-sync-status${status ? "" : " hidden"}>${escapeHtml(status)}</span>`;
      host.querySelector("[data-sync-signout]")?.addEventListener("click", async () => {
        try {
          await flush();
          const sb = await getClient();
          await sb?.auth.signOut();
          userId = null;
          email = null;
          clearFavourites();
          setStatus("");
          renderBar();
        } catch (err) {
          setStatus(err.message || "Sign out failed");
        }
      });
      return;
    }
    host.innerHTML = `
      <form class="sync-login" data-sync-login>
        <input type="email" name="email" required placeholder="email" autocomplete="email" />
        <button type="submit" class="draft-btn">Sign in</button>
      </form>
      <span class="sync-status" data-sync-status${status ? "" : " hidden"}>${escapeHtml(status)}</span>`;
    host.querySelector("[data-sync-login]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = new FormData(event.target).get("email");
      try {
        setStatus("Sending magic link…");
        await ensureAuthListener();
        const sb = await getClient();
        const redirectTo = window.location.href.split("#")[0];
        const { error } = await sb.auth.signInWithOtp({
          email: String(value || "").trim(),
          options: { emailRedirectTo: redirectTo },
        });
        if (error) throw error;
        setStatus("Check your email for the sign-in link");
      } catch (err) {
        setStatus(err.message || "Sign-in failed");
      }
    });
  }

  function toggle(playerId) {
    const key = String(playerId || "");
    if (!key) return;
    // Stars only stick while signed in (synced). Signed-out UI stays empty.
    if (!userId || !email) {
      setStatus("Sign in to save favourites");
      renderBar();
      return;
    }
    dirty = true;
    if (ids.has(key)) ids.delete(key);
    else ids.add(key);
    saveState(userId, ids);
    schedulePush();
    onChange?.();
  }

  async function hydrate() {
    if (!isSyncConfigured()) {
      ids = new Set();
      renderBar();
      onChange?.();
      return;
    }
    renderBar();
    if (!hasStoredSession()) {
      userId = null;
      email = null;
      ids = new Set();
      onChange?.();
      return;
    }
    try {
      await ensureAuthListener();
      const user = await currentUser();
      userId = user?.id || null;
      email = user?.email || null;
      if (userId) {
        ids = new Set(loadState(userId).ids);
        await applyRemote();
      } else {
        ids = new Set();
      }
    } catch (err) {
      setStatus(err.message || "Sync unavailable");
      ids = new Set();
    }
    renderBar();
    onChange?.();
  }

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && email) {
      flush().catch(() => {});
    }
  });
  window.addEventListener("pagehide", () => {
    if (email) flush().catch(() => {});
  });

  return {
    has: (id) => ids.has(String(id || "")),
    toggle,
    hydrate,
  };
}
