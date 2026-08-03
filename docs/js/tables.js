function positionFloatingTip(tip, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const pad = 8;
  let left = rect.left;
  let top = rect.bottom + 6;

  tip.hidden = false;
  left = Math.max(pad, Math.min(left, window.innerWidth - tip.offsetWidth - pad));
  if (top + tip.offsetHeight > window.innerHeight - pad) {
    top = Math.max(pad, rect.top - tip.offsetHeight - 6);
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/** Wire column header info icons to a fixed-position tooltip (idempotent). */
function initColumnTooltips() {
  let tip = document.getElementById("col-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "col-tooltip";
    tip.className = "col-tooltip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }

  const hide = () => {
    tip.hidden = true;
  };

  const show = (el) => {
    tip.textContent = el.dataset.tooltip;
    tip.hidden = false;

    const icon = el.getBoundingClientRect();
    const pad = 8;
    let left = icon.left + icon.width / 2 - tip.offsetWidth / 2;
    let top = icon.top - tip.offsetHeight - 6;

    left = Math.max(pad, Math.min(left, window.innerWidth - tip.offsetWidth - pad));
    if (top < pad) {
      top = icon.bottom + 6;
    }

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  document.querySelectorAll(".col-info").forEach((el) => {
    if (el.dataset.tooltipBound) return;
    el.dataset.tooltipBound = "1";
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("focus", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("blur", hide);
  });

  if (!window.__colTooltipWindowBound) {
    window.__colTooltipWindowBound = true;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }
}

/** Floating player-news summary on news-tag hover (idempotent per link). */
function initNewsHoverPreviews() {
  let tip = document.getElementById("news-hover-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "news-hover-tip";
    tip.className = "news-hover-tip";
    tip.hidden = true;
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }

  const hide = () => {
    tip.hidden = true;
  };

  const show = (el) => {
    const summary = el.dataset.newsSummary;
    if (!summary) return;
    tip.textContent = summary;
    positionFloatingTip(tip, el);
  };

  document.querySelectorAll(".news-tag[data-news-summary]").forEach((el) => {
    if (el.dataset.newsHoverBound) return;
    el.dataset.newsHoverBound = "1";
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("focus", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("blur", hide);
  });

  if (!window.__newsHoverWindowBound) {
    window.__newsHoverWindowBound = true;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }
}

export { initColumnTooltips, initNewsHoverPreviews };
