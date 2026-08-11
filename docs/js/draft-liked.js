/** Shared favourite-player prefs for Draft Companion + ADP board (+ Supabase sync). */

import {
  isSyncConfigured,
  getSession,
  onAuthChange,
  signInWithEmail,
  signOut,
  fetchStars,
  pickNewerStars,
  createDebouncedStarSaver,
} from "./auth-sync.js";

export const LS_LIKED = "draft-companion:liked";

function normalizeIds(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

export function loadLikedState() {
  try {
    const raw = localStorage.getItem(LS_LIKED);
    if (!raw) return { ids: [], updated_at: null };
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? normalizeIds(parsed.ids) : [];
    return {
      ids,
      updated_at: parsed?.updated_at || null,
    };
  } catch {
    return { ids: [], updated_at: null };
  }
}

export function loadLikedIds() {
  return new Set(loadLikedState().ids);
}

export function saveLikedIds(ids, updatedAt = new Date().toISOString()) {
  const normalized = normalizeIds(ids);
  localStorage.setItem(
    LS_LIKED,
    JSON.stringify({
      ids: normalized,
      updated_at: updatedAt,
    })
  );
  return { ids: normalized, updated_at: updatedAt };
}

export function toggleLikedId(likedIds, playerId) {
  const key = String(playerId || "");
  if (!key) return likedIds;
  const next = new Set(likedIds);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  saveLikedIds(next);
  return next;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Mount email magic-link sync UI and keep favourites hydrated from Supabase.
 *
 * @param {{
 *   host?: HTMLElement|null,
 *   getIds: () => Set<string>,
 *   setIds: (ids: Set<string>) => void,
 *   onChange?: () => void,
 * }} options
 */
export function mountStarSync(options) {
  const { host, getIds, setIds, onChange } = options;
  let syncStatus = isSyncConfigured() ? "Checking sync…" : "Local only";
  let signedInEmail = null;

  const remoteSaver = createDebouncedStarSaver({
    onSuccess: () => {
      if (signedInEmail) setSyncStatus("Favourites synced");
    },
    onError: (err) => {
      setSyncStatus(err.message || "Favourites sync failed");
    },
  });

  function setSyncStatus(text) {
    syncStatus = text;
    const el = host?.querySelector?.("[data-sync-status]");
    if (el) el.textContent = text;
  }

  function currentPayload() {
    return {
      ids: [...getIds()],
      updated_at: loadLikedState().updated_at || new Date().toISOString(),
    };
  }

  function persistLocalAndMaybeRemote() {
    const state = saveLikedIds(getIds());
    if (isSyncConfigured() && signedInEmail) {
      setSyncStatus("Saving favourites…");
      remoteSaver.schedule(state);
    }
  }

  function renderSyncBar() {
    if (!host) return;
    host.classList.add("sync-bar");
    host.hidden = false;

    if (!isSyncConfigured()) {
      host.innerHTML = `<span class="sync-status" data-sync-status>Local only — add Supabase keys in sync-config.js</span>`;
      return;
    }

    if (signedInEmail) {
      host.innerHTML = `
        <span class="sync-status" data-sync-status>${escapeHtml(syncStatus)}</span>
        <span class="sync-user">${escapeHtml(signedInEmail)}</span>
        <button type="button" class="draft-btn" data-sync-signout>Sign out</button>`;
      host.querySelector("[data-sync-signout]")?.addEventListener("click", async () => {
        try {
          await remoteSaver.flush();
          await signOut();
          signedInEmail = null;
          setSyncStatus("Signed out — local only until you sign in");
          renderSyncBar();
        } catch (err) {
          setSyncStatus(err.message || "Sign out failed");
        }
      });
      return;
    }

    host.innerHTML = `
      <span class="sync-status" data-sync-status>${escapeHtml(syncStatus)}</span>
      <form class="sync-login" data-sync-login>
        <input type="email" name="email" required placeholder="Email for magic link" autocomplete="email" />
        <button type="submit" class="draft-btn">Sign in to sync favourites</button>
      </form>`;
    host.querySelector("[data-sync-login]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = new FormData(event.target).get("email");
      try {
        setSyncStatus("Sending magic link…");
        await signInWithEmail(email);
        setSyncStatus("Check your email for the sign-in link");
      } catch (err) {
        setSyncStatus(err.message || "Sign-in failed");
      }
    });
  }

  async function applyMergedState(localState, remoteState) {
    const { source, state } = pickNewerStars(localState, remoteState);
    if (!state) {
      if (!signedInEmail && isSyncConfigured()) {
        setSyncStatus("Sign in to sync favourites across devices");
      } else if (!isSyncConfigured()) {
        setSyncStatus("Local only");
      }
      return;
    }

    setIds(new Set(normalizeIds(state.ids)));
    saveLikedIds(state.ids, state.updated_at || new Date().toISOString());
    onChange?.();

    if (source === "remote") {
      setSyncStatus("Loaded synced favourites");
    } else if (source === "local" && signedInEmail) {
      remoteSaver.schedule(currentPayload());
      setSyncStatus("Synced local favourites to cloud");
    } else if (!signedInEmail && isSyncConfigured()) {
      setSyncStatus("Sign in to sync favourites across devices");
    } else {
      setSyncStatus("Local only");
    }
  }

  async function hydrate() {
    const localState = loadLikedState();
    setIds(new Set(localState.ids));

    if (!isSyncConfigured()) {
      setSyncStatus("Local only");
      renderSyncBar();
      onChange?.();
      return { signedIn: false };
    }

    try {
      const session = await getSession();
      signedInEmail = session?.user?.email || null;
      let remote = null;
      if (signedInEmail) {
        remote = await fetchStars();
      }
      await applyMergedState(localState, remote);
    } catch (err) {
      setSyncStatus(err.message || "Sync unavailable");
    }
    renderSyncBar();
    onChange?.();
    return { signedIn: Boolean(signedInEmail) };
  }

  if (isSyncConfigured()) {
    onAuthChange(async (session) => {
      const email = session?.user?.email || null;
      const wasSignedIn = Boolean(signedInEmail);
      signedInEmail = email;
      renderSyncBar();
      if (email && !wasSignedIn) {
        try {
          const remote = await fetchStars();
          await applyMergedState(loadLikedState(), remote);
          renderSyncBar();
        } catch (err) {
          setSyncStatus(err.message || "Sync failed");
          renderSyncBar();
        }
      } else if (!email) {
        setSyncStatus("Sign in to sync favourites across devices");
        renderSyncBar();
      }
    });
  }

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && signedInEmail) {
      remoteSaver.flush().catch(() => {});
    }
  });
  window.addEventListener("pagehide", () => {
    if (signedInEmail) remoteSaver.flush().catch(() => {});
  });

  return {
    hydrate,
    persistLocalAndMaybeRemote,
    renderSyncBar,
    isSignedIn: () => Boolean(signedInEmail),
  };
}
