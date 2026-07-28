import { fetchJSON, formatTimestamp, showError } from "./config.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const name = escapeHtml(player.player_name || "Unknown player");
  const team = player.team ? ` · ${escapeHtml(player.team)}` : "";
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
            <span class="player-name">${name}</span>
            <span class="player-team">${team}</span>
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
      <div class="injury-card-body" hidden>
        ${sourcesHtml(player.timeline)}
      </div>
    </article>`;
}

function bindExpand(container) {
  container.addEventListener("click", (event) => {
    const header = event.target.closest(".injury-card-header");
    if (!header) return;
    const card = header.closest(".injury-card");
    const body = card.querySelector(".injury-card-body");
    const expanded = header.getAttribute("aria-expanded") === "true";
    header.setAttribute("aria-expanded", expanded ? "false" : "true");
    body.hidden = expanded;
    const hint = header.querySelector(".expand-hint");
    if (hint) hint.textContent = expanded ? "+" : "−";
  });
}

async function mountInjuriesPage() {
  const container = document.getElementById("injuries-container");
  const meta = document.querySelector("[data-injuries='summary']");

  try {
    const data = await fetchJSON("injuries/summaries.json");
    const players = [...(data.players || [])].sort((a, b) =>
      String(b.last_updated || "").localeCompare(String(a.last_updated || ""))
    );
    if (meta) {
      meta.textContent = data.last_updated
        ? `Updated ${formatTimestamp(data.last_updated)} · ${players.length} players`
        : `No refresh yet · ${players.length} players`;
    }

    if (!players.length) {
      container.innerHTML =
        `<p class="meta">No player news yet. Run <code>python -m src.run_injuries</code> after configuring <code>GEMINI_API_KEY</code>.</p>`;
      return;
    }

    container.innerHTML = players.map(playerCard).join("");
    bindExpand(container);

    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const target = document.getElementById(hash);
      if (target) {
        target.classList.add("injury-card-target");
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  } catch (err) {
    showError(container, err.message);
  }
}

export { mountInjuriesPage };
