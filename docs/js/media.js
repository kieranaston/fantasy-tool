import { fetchJSON } from "./config.js?v=6";

let headshotById = null;
let headshotVersion = null;

/** Load sleeper-id → headshot URL sidecar (cached per version). */
export async function loadHeadshots(version = null) {
  if (headshotById && headshotVersion === version) return headshotById;
  try {
    const data = await fetchJSON("draft/headshots.json", { version });
    headshotById = data.by_sleeper_id || {};
    headshotVersion = version;
  } catch {
    headshotById = {};
    headshotVersion = version;
  }
  return headshotById;
}

export function attachHeadshot(player, map = headshotById) {
  if (!player || player.headshot) return player;
  const id = String(player.sleeper_id || player.player_id || "")
    .replace(/^sleeper:/, "")
    .trim();
  const url = map?.[id];
  return url ? { ...player, headshot: url } : player;
}

export function attachHeadshots(players, map = headshotById) {
  return (players || []).map((p) => attachHeadshot(p, map));
}
