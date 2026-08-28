import { fetchJSON, formatTimestamp, formatUpdated, showError, revealPage } from "./config.js";
import { escapeHtml, playerLabelHtml } from "./shared.js";

const BSKY_FEED_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
const BSKY_ACTOR = "rotowirenfl.bsky.social";
const BSKY_PAGE_LIMIT = 30;
/** Max player cards shown (newest first, after freshness filter). */
const DISPLAY_LIMIT = 40;
/** RotoWire blurbs are almost always "Player Name: update …" */
const ROTOWIRE_LINE =
  /^\s*([^:\n]{2,80}?)\s*:\s*(.+?)\s*$/m;

/** Format like "Jul 27". */
function formatUpdateDay(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { month: "short", day: "numeric" });
}

function normName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripUrls(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

function atUriToWebUrl(uri, handle) {
  const rkey = String(uri || "")
    .replace(/\/$/, "")
    .split("/")
    .pop();
  if (!rkey) return "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function isFreshTimestamp(isoString, maxAgeDays) {
  const days = Number(maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) return true;
  const ts = Date.parse(isoString || "");
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= days * 24 * 60 * 60 * 1000;
}

function freshTimeline(timeline, maxAgeDays) {
  return (timeline || []).filter((item) =>
    isFreshTimestamp(item.timestamp, maxAgeDays)
  );
}

function sourcesHtml(timeline) {
  const items = timeline || [];
  if (!items.length) {
    return `<p class="timeline-empty">No sources yet.</p>`;
  }
  return `
    <ol class="injury-timeline">
      ${items
        .map((item) => {
          const when = item.timestamp
            ? formatTimestamp(item.timestamp)
            : "Unknown time";
          const link = item.url
            ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">link</a>`
            : `<span class="source-chip">link</span>`;
          return `
            <li>
              <div class="timeline-meta">
                <span>${escapeHtml(when)}</span>
                ${link}
              </div>
              <p class="timeline-text">${escapeHtml(item.source_text || "")}</p>
            </li>`;
        })
        .join("")}
    </ol>`;
}

/** Card body: only the newest post text. */
function latestPostHtml(player) {
  const timeline = player.timeline || [];
  const newest = timeline[0];
  const raw = String((newest && newest.source_text) || "").trim();
  const text = stripUrls(raw).replace(/\n{2,}/g, "\n").trim();
  if (!text) return `<p class="injury-blurb muted">No recent post yet.</p>`;
  return `<div class="injury-blurb injury-latest-post"><p class="timeline-text">${escapeHtml(
    text
  )}</p></div>`;
}

function playerCard(player, maxAgeDays) {
  const rawId = String(player.player_id || "");
  const id = escapeHtml(rawId);
  const safeId = escapeHtml(rawId.replace(/[^a-zA-Z0-9_-]+/g, "-"));
  const updateDay = formatUpdateDay(player.last_updated);
  const updateTag = updateDay
    ? `<span class="update-tag">${escapeHtml(updateDay)}</span>`
    : "";
  const sourceCount = freshTimeline(player.timeline, maxAgeDays).length;

  return `
    <article class="injury-card" id="player-${safeId}" data-player-id="${id}">
      <div class="injury-card-main">
        <div class="injury-card-title">
          <div class="injury-card-identity">
            ${playerLabelHtml(player, { name: player.player_name })}
          </div>
          <span class="injury-card-meta">${updateTag}</span>
        </div>
        ${latestPostHtml(player)}
      </div>
      <button type="button" class="injury-card-header" aria-expanded="false">
        <span class="sources-toggle-label">Sources (${sourceCount})</span>
        <span class="expand-hint" aria-hidden="true">+</span>
      </button>
      <div class="injury-card-body" hidden data-lazy-sources="1"></div>
    </article>`;
}

function bindExpand(container, playersById, maxAgeDays) {
  container.addEventListener("click", (event) => {
    const header = event.target.closest(".injury-card-header");
    if (!header) return;
    const card = header.closest(".injury-card");
    const body = card.querySelector(".injury-card-body");
    const expanded = header.getAttribute("aria-expanded") === "true";
    if (!expanded && body?.dataset.lazySources === "1") {
      const player = playersById.get(card.getAttribute("data-player-id"));
      body.innerHTML = sourcesHtml(
        freshTimeline(player?.timeline, maxAgeDays)
      );
      delete body.dataset.lazySources;
    }
    header.setAttribute("aria-expanded", expanded ? "false" : "true");
    body.hidden = expanded;
    const hint = header.querySelector(".expand-hint");
    if (hint) hint.textContent = expanded ? "+" : "−";
  });
}

function isFreshPlayer(player, maxAgeDays) {
  return isFreshTimestamp(player.last_updated, maxAgeDays);
}

function matchesNewsQuery(player, query) {
  if (!query) return true;
  const newest = (player.timeline || [])[0];
  const haystack = [player.player_name, player.team, newest?.source_text]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  return haystack.includes(query);
}

function parseRotowirePost(entry) {
  const post = entry?.post || {};
  const record = post.record || {};
  const text = String(record.text || "").trim();
  if (!text) return null;
  const handle = post.author?.handle || BSKY_ACTOR;
  const uri = post.uri || "";
  const url = uri ? atUriToWebUrl(uri, handle) : "";
  if (!url) return null;
  const createdAt = record.createdAt || post.indexedAt || "";
  const cleaned = stripUrls(text);
  const match = cleaned.match(ROTOWIRE_LINE);
  const playerName = match ? match[1].trim() : null;
  const designation = match ? match[2].split("\n")[0].trim().replace(/^[-–—\s]+/, "") : "";
  return {
    url,
    timestamp: createdAt,
    source_text: text,
    player_name: playerName,
    designation,
  };
}

/** Pull recent RotoWire posts from Bluesky (CORS-open public API). */
async function fetchLiveRotowirePosts({ timeoutMs = 8000 } = {}) {
  const url = new URL(BSKY_FEED_URL);
  url.searchParams.set("actor", BSKY_ACTOR);
  url.searchParams.set("limit", String(BSKY_PAGE_LIMIT));
  url.searchParams.set("filter", "posts_no_replies");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!response.ok) {
      throw new Error(`Bluesky feed ${response.status}`);
    }
    const payload = await response.json();
    const out = [];
    for (const entry of payload.feed || []) {
      const parsed = parseRotowirePost(entry);
      if (parsed) out.push(parsed);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function findPlayerByName(players, name) {
  const key = normName(name);
  if (!key) return null;
  for (const player of players) {
    if (normName(player.player_name) === key) return player;
  }
  return null;
}

function mergeLivePosts(players, livePosts) {
  const list = players.map((p) => ({
    ...p,
    timeline: [...(p.timeline || [])],
  }));
  const knownUrls = new Set();
  for (const player of list) {
    for (const item of player.timeline) {
      if (item?.url) knownUrls.add(item.url);
    }
  }

  let added = 0;
  const chronological = [...livePosts].reverse();
  for (const post of chronological) {
    if (!post.url || knownUrls.has(post.url)) continue;
    knownUrls.add(post.url);

    const item = {
      id: `live:${post.url}`,
      timestamp: post.timestamp,
      designation: post.designation || "",
      source_text: post.source_text,
      url: post.url,
      source_type: "beat_reporter",
      player_name: post.player_name,
    };

    let player = post.player_name
      ? findPlayerByName(list, post.player_name)
      : null;
    if (!player) {
      if (!post.player_name) continue;
      player = {
        player_id: `live:${normName(post.player_name).replace(/\s+/g, "-")}`,
        player_name: post.player_name,
        last_updated: post.timestamp,
        timeline: [],
        team: null,
      };
      list.push(player);
    }

    player.timeline.unshift(item);
    player.last_updated = post.timestamp || player.last_updated;
    added += 1;
  }

  return {
    players: list,
    added,
  };
}

async function mountInjuriesPage() {
  const container = document.getElementById("injuries-container");
  const meta = document.querySelector("[data-injuries='summary']");
  const searchInput = document.getElementById("news-player-search");
  const failsafe = setTimeout(() => revealPage(), 4000);

  try {
    const data = await fetchJSON("injuries/summaries.json");

    let players = [...(data.players || [])].sort((a, b) =>
      String(b.last_updated || "").localeCompare(String(a.last_updated || ""))
    );
    let liveNote = "";
    const maxAgeDays = Number(data.news_max_age_days) || 7;

    const playersById = new Map(
      players.map((p) => [String(p.player_id), p])
    );
    let searchTimer = null;

    function visiblePlayers() {
      return players
        .filter((p) => isFreshPlayer(p, maxAgeDays))
        .slice(0, DISPLAY_LIMIT);
    }

    function render(filtered) {
      if (meta) {
        meta.textContent = `${formatUpdated(data.last_updated)}${liveNote}`;
      }
      if (!filtered.length) {
        container.innerHTML = players.length
          ? `<p class="meta">No players match.</p>`
          : `<p class="meta">No player news yet.</p>`;
        return;
      }
      container.innerHTML = filtered
        .map((player) => playerCard(player, maxAgeDays))
        .join("");
    }

    function applyFilter() {
      const query = String(searchInput?.value || "")
        .trim()
        .toLowerCase();
      render(visiblePlayers().filter((p) => matchesNewsQuery(p, query)));
    }

    searchInput?.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilter, 120);
    });
    bindExpand(container, playersById, maxAgeDays);

    applyFilter();
    revealPage();

    fetchLiveRotowirePosts()
      .then((livePosts) => {
        const merged = mergeLivePosts(players, livePosts);
        if (!merged.added) return;
        players = merged.players;
        players.sort((a, b) =>
          String(b.last_updated || "").localeCompare(String(a.last_updated || ""))
        );
        playersById.clear();
        for (const p of players) playersById.set(String(p.player_id), p);
        liveNote = ` · ${merged.added} new`;
        applyFilter();
      })
      .catch(() => {});
  } catch (err) {
    if (container) showError(container, err.message || String(err));
    else if (meta) meta.textContent = err.message || String(err);
  } finally {
    clearTimeout(failsafe);
    revealPage();
  }

  const hash = window.location.hash.replace(/^#/, "");
  if (hash) {
    const target = document.getElementById(hash);
    if (target) {
      target.classList.add("injury-card-target");
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

export { mountInjuriesPage };
