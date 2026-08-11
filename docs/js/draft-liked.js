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
  let hydrateDone = false;
  /** Bumped on every local favourite edit; stale remote merges must not apply. */
  let localEpoch = 0;

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
    localEpoch += 1;
    const state = saveLikedIds(getIds());
    if (isSyncConfigured() && signedInEmail) {
      setSyncStatus("Saving favourites…");
      remoteSaver.schedule(state);
    }
    onChange?.();
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

  async function applyMergedState(localState, remoteState, { epoch = localEpoch } = {}) {
    if (epoch !== localEpoch) return;

    const { source, state } = pickNewerStars(localState, remoteState);
    if (!state) {
      if (!signedInEmail && isSyncConfigured()) {
        setSyncStatus("Sign in to sync favourites across devices");
      } else if (!isSyncConfigured()) {
        setSyncStatus("Local only");
      }
      return;
    }

    if (epoch !== localEpoch) return;

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

  async function hydrateFromRemote() {
    const epoch = localEpoch;
    const localState = loadLikedState();
    const remote = await fetchStars();
    if (epoch !== localEpoch) return;
    await applyMergedState(localState, remote, { epoch });
  }

  async function hydrate() {
    const localState = loadLikedState();
    setIds(new Set(localState.ids));

    if (!isSyncConfigured()) {
      setSyncStatus("Local only");
      renderSyncBar();
      onChange?.();
      hydrateDone = true;
      return { signedIn: false };
    }

    try {
      const session = await getSession();
      signedInEmail = session?.user?.email || null;
      if (signedInEmail) {
        await hydrateFromRemote();
      } else if (localState.ids.length) {
        setSyncStatus("Sign in to sync favourites across devices");
      } else {
        setSyncStatus("Sign in to sync favourites across devices");
      }
    } catch (err) {
      setSyncStatus(err.message || "Sync unavailable");
    }
    renderSyncBar();
    onChange?.();
    hydrateDone = true;
    return { signedIn: Boolean(signedInEmail) };
  }

  if (isSyncConfigured()) {
    onAuthChange(async (event, session) => {
      const email = session?.user?.email || null;

      // Initial session is handled by hydrate(); ignore it to avoid a second
      // fetch that can race with (and overwrite) favourites toggles.
      if (event === "INITIAL_SESSION") {
        if (!hydrateDone && email) signedInEmail = email;
        return;
      }

      if (event === "SIGNED_OUT" || !email) {
        signedInEmail = null;
        setSyncStatus("Sign in to sync favourites across devices");
        renderSyncBar();
        return;
      }

      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        const wasSignedIn = Boolean(signedInEmail);
        signedInEmail = email;
        renderSyncBar();
        if (!wasSignedIn || event === "SIGNED_IN") {
          try {
            await hydrateFromRemote();
            renderSyncBar();
          } catch (err) {
            setSyncStatus(err.message || "Sync failed");
            renderSyncBar();
          }
        }
        return;
      }

      // TOKEN_REFRESHED etc. — keep email, don't re-merge.
      if (email) signedInEmail = email;
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
