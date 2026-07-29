import { fetchJSON, formatTimestamp, showError } from "./config.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chipsHtml(player) {
  const chips = [];
  if (player.ir_weeks?.length) {
    chips.push(`IR ${player.ir_weeks.length} wk${player.ir_weeks.length === 1 ? "" : "s"}`);
  }
  if (player.inactive_weeks?.length) {
    chips.push(`Inactive ${player.inactive_weeks.length}`);
  }
  if (player.missed_weeks?.length) {
    chips.push(`Missed ${player.missed_weeks.length} game${player.missed_weeks.length === 1 ? "" : "s"}`);
  }
  if (player.out_weeks?.length) {
    chips.push(`Out report ${player.out_weeks.length}`);
  }
  if (player.primary_injuries?.length) {
    chips.push(player.primary_injuries.slice(0, 3).join(" / "));
  }
  if (!chips.length) return "";
  return `<div class="history-chips">${chips
    .map((c) => `<span class="history-chip">${escapeHtml(c)}</span>`)
    .join("")}</div>`;
}

function weekRowClass(week) {
  if (week.is_bye) return "history-week-bye";
  if (week.player_played) return "history-week-played";
  if (week.roster_status === "RES") return "history-week-ir";
  if (week.roster_status === "INA") return "history-week-inactive";
  if (!week.player_played && week.team_played) return "history-week-missed";
  return "";
}

function weeksTableHtml(player) {
  const weeks = (player.weeks || []).filter(
    (w) =>
      w.is_bye ||
      w.player_played ||
      w.roster_status === "RES" ||
      w.roster_status === "INA" ||
      w.report_status ||
      w.practice_status ||
      (!w.player_played && w.team_played)
  );
  if (!weeks.length) {
    return `<p class="meta">No week-level detail available.</p>`;
  }

  const rows = weeks
    .map((w) => {
      let availability;
      if (w.is_bye) {
        availability = "Bye";
      } else if (w.player_played) {
        availability = "Played";
      } else if (w.roster_status === "ACT") {
        availability = "Active";
      } else {
        availability = "Inactive";
      }
      const report = [w.report_status, w.injury].filter(Boolean).join(" · ") || "—";
      const practice = w.practice_status || "—";
      return `
        <tr class="${weekRowClass(w)}">
          <td>W${w.week}</td>
          <td>${escapeHtml(availability)}</td>
          <td>${escapeHtml(report)}</td>
          <td>${escapeHtml(practice)}</td>
        </tr>`;
    })
    .join("");

  return `
    <div class="history-section">
      <h3 class="history-section-title">Week-by-week</h3>
      <div class="table-wrap history-week-wrap">
        <table class="history-week-table">
          <thead>
            <tr>
              <th>Week</th>
              <th>Availability</th>
              <th>Injury report</th>
              <th>Practice</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function playerCard(player) {
  const id = escapeHtml(player.player_id);
  const name = escapeHtml(player.player_name || "Unknown player");
  const team = player.team ? escapeHtml(player.team) : "";
  const pos = player.position ? escapeHtml(player.position) : "";
  const logo = player.logo
    ? `<img class="team-logo" src="${escapeHtml(player.logo)}" alt="${team}">`
    : "";
  const gp =
    player.team_games != null
      ? `${player.games_played ?? 0}/${player.team_games} GP`
      : `${player.games_played ?? 0} GP`;

  return `
    <article class="injury-card history-card" id="player-${id}" data-player-id="${id}" data-position="${pos}" data-name="${name.toLowerCase()}">
      <div class="injury-card-main">
        <div class="injury-card-title">
          <div class="injury-card-identity">
            ${logo}
            <span class="player-name">${name}</span>
            <span class="player-team">${pos}${pos && team ? " · " : ""}${team}</span>
          </div>
          <span class="update-tag">${escapeHtml(gp)}</span>
        </div>
        ${chipsHtml(player)}
        <p class="injury-blurb">${escapeHtml(player.overview || player.summary || "")}</p>
      </div>
      <button type="button" class="injury-card-header" aria-expanded="false">
        <span class="sources-toggle-label">Week detail</span>
        <span class="expand-hint" aria-hidden="true">+</span>
      </button>
      <div class="injury-card-body" hidden>
        ${weeksTableHtml(player)}
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

function applyFilters(container, position, query) {
  const q = query.trim().toLowerCase();
  container.querySelectorAll(".history-card").forEach((card) => {
    const posOk = position === "all" || card.dataset.position === position;
    const nameOk = !q || (card.dataset.name || "").includes(q);
    card.hidden = !(posOk && nameOk);
  });
}

async function mountInjuryHistoryPage() {
  const container = document.getElementById("history-container");
  const meta = document.querySelector("[data-history='summary']");
  const positionSelect = document.getElementById("history-position");
  const searchInput = document.getElementById("history-search");

  try {
    const data = await fetchJSON("injuries/history.json");
    const players = [...(data.players || [])];
    if (meta) {
      const updated = data.last_updated
        ? `Updated ${formatTimestamp(data.last_updated)}`
        : "No refresh yet";
      meta.textContent = `${data.title || "Season Injury History"} · ${updated} · ${players.length} players`;
    }

    if (!players.length) {
      container.innerHTML =
        `<p class="meta">No history yet. Run <code>python -m src.run_injury_history</code>.</p>`;
      return;
    }

    container.innerHTML = players.map(playerCard).join("");
    bindExpand(container);

    const rerenderFilters = () =>
      applyFilters(
        container,
        positionSelect?.value || "all",
        searchInput?.value || ""
      );
    positionSelect?.addEventListener("change", rerenderFilters);
    searchInput?.addEventListener("input", rerenderFilters);

    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const target = document.getElementById(hash);
      if (target) {
        target.hidden = false;
        target.classList.add("injury-card-target");
        const header = target.querySelector(".injury-card-header");
        const body = target.querySelector(".injury-card-body");
        if (header && body) {
          header.setAttribute("aria-expanded", "true");
          body.hidden = false;
          const hint = header.querySelector(".expand-hint");
          if (hint) hint.textContent = "−";
        }
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  } catch (err) {
    showError(container, err.message);
  }
}

export { mountInjuryHistoryPage };
