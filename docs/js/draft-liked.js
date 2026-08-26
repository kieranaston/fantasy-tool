/**
 * Favourites: localStorage always, optional email sync via Supabase.
 * Last write wins. A star tapped during a cloud fetch is kept.
 */

import { escapeHtml } from "./shared.js?v=6";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isSyncConfigured,
} from "./sync-config.js";

const LS_KEY = "draft-companion:liked";
const SAVE_MS = 400;
const SB_SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

function normalizeIds(ids) {
  const list = ids == null ? [] : Array.isArray(ids) ? ids : [...ids];
  return [...new Set(list.map(String).filter(Boolean))];
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return {
      ids: Array.isArray(parsed?.ids) ? normalizeIds(parsed.ids) : [],
      updated_at: parsed?.updated_at || null,
    };
  } catch {
    return { ids: [], updated_at: null };
  }
}

function saveState(ids, updatedAt = new Date().toISOString()) {
  const state = { ids: normalizeIds(ids), updated_at: updatedAt };
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  return state;
}

function ts(iso) {
  const n = Date.parse(iso || "");
  return Number.isNaN(n) ? 0 : n;
}

let client = null;

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
  let ids = new Set(loadState().ids);
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

  async function currentUser() {
    const sb = await getClient();
    if (!sb) return null;
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data.session?.user || null;
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
    if (!email) return;
    pending = loadState();
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
    if (pending) {
      const next = pending;
      pending = null;
      await writeRemote(next);
    }
    await writing;
  }

  async function applyRemote() {
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
    const local = loadState();
    if (remote && ts(remote.updated_at) > ts(local.updated_at)) {
      ids = new Set(normalizeIds(remote.ids));
      saveState(remote.ids, remote.updated_at);
      onChange?.();
      setStatus("");
    } else if (email && local.ids.length) {
      schedulePush();
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
          email = null;
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
    dirty = true;
    if (ids.has(key)) ids.delete(key);
    else ids.add(key);
    saveState(ids);
    if (email) schedulePush();
    onChange?.();
  }

  async function hydrate() {
    ids = new Set(loadState().ids);
    if (!isSyncConfigured()) {
      renderBar();
      onChange?.();
      return;
    }
    try {
      const user = await currentUser();
      email = user?.email || null;
      if (email) await applyRemote();
    } catch (err) {
      setStatus(err.message || "Sync unavailable");
    }
    renderBar();
    onChange?.();
  }

  if (isSyncConfigured()) {
    getClient().then((sb) => {
      if (!sb) return;
      sb.auth.onAuthStateChange((event, session) => {
        queueMicrotask(async () => {
          if (event === "INITIAL_SESSION") return;
          const next = session?.user?.email || null;
          if (event === "SIGNED_OUT" || !next) {
            email = null;
            setStatus("");
            renderBar();
            return;
          }
          if (event === "SIGNED_IN") {
            email = next;
            renderBar();
            try {
              await applyRemote();
            } catch (err) {
              setStatus(err.message || "Sync failed");
            }
            renderBar();
            return;
          }
          if (next) email = next;
        });
      });
    });
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
