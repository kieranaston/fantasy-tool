/**
 * Favourites stored in localStorage only (this browser).
 */

const LS_KEY = "draft-companion:liked";
const LS_KEY_GUEST = "draft-companion:liked:guest";
const LS_KEY_LEGACY_USER_PREFIX = "draft-companion:liked:user:";

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

function loadState() {
  const primary = readKey(LS_KEY);
  if (primary.ids.length || primary.updated_at) return primary;

  // Prefer former guest bucket, then merge any leftover per-user buckets once.
  const guest = readKey(LS_KEY_GUEST);
  const merged = new Set(guest.ids);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LS_KEY_LEGACY_USER_PREFIX)) continue;
      for (const id of readKey(key).ids) merged.add(id);
    }
  } catch {
    /* ignore */
  }

  const ids = [...merged];
  if (!ids.length && !guest.updated_at) return { ids: [], updated_at: null };

  const state = {
    ids,
    updated_at: guest.updated_at || new Date().toISOString(),
  };
  saveState(state.ids, state.updated_at);
  try {
    localStorage.removeItem(LS_KEY_GUEST);
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LS_KEY_LEGACY_USER_PREFIX)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  return state;
}

function saveState(ids, updatedAt = new Date().toISOString()) {
  const state = { ids: normalizeIds(ids), updated_at: updatedAt };
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  return state;
}

/**
 * @param {{ onChange?: () => void }} [options]
 */
export function createFavourites(options = {}) {
  const { onChange } = options;
  let ids = new Set();

  function toggle(playerId) {
    const key = String(playerId || "");
    if (!key) return;
    if (ids.has(key)) ids.delete(key);
    else ids.add(key);
    saveState(ids);
    onChange?.();
  }

  function hydrate() {
    ids = new Set(loadState().ids);
    onChange?.();
  }

  return {
    has: (id) => ids.has(String(id || "")),
    toggle,
    hydrate,
  };
}
