import { fetchJSON, formatTimestamp, showError, revealPage } from "./config.js?v=2";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function playerMediaHtml(player, { name } = {}) {
  const display = escapeHtml(name || player?.player_name || player?.player || "Unknown");
  const logo = player?.logo;
  const team = player?.team ? String(player.team).toUpperCase() : "";
  const teamBits = [];
  if (logo) {
    teamBits.push(
      `<img class="team-logo" src="${escapeHtml(logo)}" alt="" width="16" height="16" loading="lazy" decoding="async" />`
    );
  }
  if (team) teamBits.push(`<span>${escapeHtml(team)}</span>`);
  const teamHtml = teamBits.length
    ? `<span class="player-media-team">${teamBits.join("")}</span>`
    : "";
  return `<span class="player-media player-media--text"><span class="player-media-text"><span class="player-media-name">${display}</span>${teamHtml}</span></span>`;
}

function ordinalDay(day) {
  const j = day % 10;
  const k = day % 100;
  if (j === 1 && k !== 11) return `${day}st`;
  if (j === 2 && k !== 12) return `${day}nd`;
  if (j === 3 && k !== 13) return `${day}rd`;
  return `${day}th`;
}

/** Format like "July 27th". */
function formatUpdateDay(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const month = date.toLocaleString(undefined, { month: "long" });
  return `${month} ${ordinalDay(date.getDate())}`;
}

function sourcesHtml(timeline) {
  if (!timeline || !timeline.length) {
    return `<p class="timeline-empty">No sources yet.</p>`;
  }
  return `
    <ol class="injury-timeline">
      ${timeline
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

function playerCard(player) {
  const id = escapeHtml(player.player_id);
  const updateDay = formatUpdateDay(player.last_updated);
  const updateTag = updateDay
    ? `<span class="update-tag">${escapeHtml(updateDay)}</span>`
    : "";
  const sourceCount = (player.timeline || []).length;
  const blurb = player.diff_summary
    ? escapeHtml(player.diff_summary)
    : "No generated summary yet.";
  const blurbClass = player.diff_summary ? "injury-blurb" : "injury-blurb muted";
  const designation = (player.current_designation || "").trim();
  const statusChip = designation
    ? `<span class="status-chip">${escapeHtml(designation)}</span>`
    : "";

  return `
    <article class="injury-card" id="player-${id}" data-player-id="${id}">
      <div class="injury-card-main">
        <div class="injury-card-title">
          <div class="injury-card-identity">
            ${playerMediaHtml(player)}
          </div>
          ${updateTag}
        </div>
        ${statusChip}
        <p class="${blurbClass}">${blurb}</p>
      </div>
      <button type="button" class="injury-card-header" aria-expanded="false">
        <span class="sources-toggle-label">Sources (${sourceCount})</span>
        <span class="expand-hint" aria-hidden="true">+</span>
      </button>
      <div class="injury-card-body" hidden data-lazy-sources="1"></div>
    </article>`;
}

function bindExpand(container, playersById) {
  container.addEventListener("click", (event) => {
    const header = event.target.closest(".injury-card-header");
    if (!header) return;
    const card = header.closest(".injury-card");
    const body = card.querySelector(".injury-card-body");
    const expanded = header.getAttribute("aria-expanded") === "true";
    if (!expanded && body?.dataset.lazySources === "1") {
      const player = playersById.get(card.getAttribute("data-player-id"));
      body.innerHTML = sourcesHtml(player?.timeline);
      delete body.dataset.lazySources;
    }
    header.setAttribute("aria-expanded", expanded ? "false" : "true");
    body.hidden = expanded;
    const hint = header.querySelector(".expand-hint");
    if (hint) hint.textContent = expanded ? "+" : "−";
  });
}

function matchesNewsQuery(player, query) {
  if (!query) return true;
  const haystack = [
    player.player_name,
    player.team,
    player.current_designation,
    player.diff_summary,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  return haystack.includes(query);
}

async function mountInjuriesPage() {
  const container = document.getElementById("injuries-container");
  const meta = document.querySelector("[data-injuries='summary']");
  const searchInput = document.getElementById("news-player-search");
  // Never leave the page stuck on the hidden loading shell.
  const failsafe = setTimeout(() => revealPage(), 4000);

  try {
    const data = await fetchJSON("injuries/summaries.json");
    const players = [...(data.players || [])].sort((a, b) =>
      String(b.last_updated || "").localeCompare(String(a.last_updated || ""))
    );

    const playersById = new Map(
      players.map((p) => [String(p.player_id), p])
    );
    let searchTimer = null;

    function render(filtered) {
      if (meta) {
        meta.textContent = data.last_updated
          ? formatTimestamp(data.last_updated)
          : "No refresh yet";
      }
      if (!filtered.length) {
        container.innerHTML = players.length
          ? `<p class="meta">No players match.</p>`
          : `<p class="meta">No player news yet.</p>`;
        return;
      }
      container.innerHTML = filtered.map(playerCard).join("");
    }

    function applyFilter() {
      const query = String(searchInput?.value || "")
        .trim()
        .toLowerCase();
      render(players.filter((p) => matchesNewsQuery(p, query)));
    }

    searchInput?.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilter, 120);
    });
    bindExpand(container, playersById);
    applyFilter();
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
