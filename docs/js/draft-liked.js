/** Shared starred-player prefs for Draft Companion + ADP board. */

export const LS_LIKED = "draft-companion:liked";

export function loadLikedIds() {
  try {
    const raw = localStorage.getItem(LS_LIKED);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
    return new Set(ids.map(String).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function saveLikedIds(ids) {
  localStorage.setItem(
    LS_LIKED,
    JSON.stringify({
      ids: [...ids],
      updated_at: new Date().toISOString(),
    })
  );
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
