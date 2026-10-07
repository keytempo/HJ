// Episode archive: lists every episode from the manifest, with search, season
// filters, a sort order, and per-episode stars (kept in localStorage). It only
// ever reads the manifest, never an individual episode's panel map, so there's
// no reader state here. Archive access and DOM helpers come from shared.js,
// which loads first.
//
// Reading order is ascending `episode`, and every link into the reader uses
// `episode` (not the story-facing "Ep. N" number in the title, which drifts
// from `episode` after the Special episode).

const SKELETON_COUNT = 10;
const SEARCH_DEBOUNCE_MS = 120;
// localStorage key holding the starred episode numbers (a JSON array).
const STARRED_KEY = "hj:starred";
// Season order when grouped; `key` is what seasonKey() returns.
const SEASONS = [
  { key: "s1", label: "Season One" },
  { key: "s2", label: "Season Two" },
];

const controls = document.getElementById("controls");
const searchInput = document.getElementById("search-input");
const filterButtons = [...document.querySelectorAll(".filter-btn")];
const sortButton = document.getElementById("sort-toggle");
const sortLabel = document.getElementById("sort-label");
const sortIcon = document.getElementById("sort-icon");
const resultsCount = document.getElementById("results-count");
const content = document.getElementById("archive-content");
const statEpisodes = document.querySelector('[data-stat="episodes"]');
const statPanels = document.querySelector('[data-stat="panels"]');
const statSeasons = document.querySelector('[data-stat="seasons"]');

let episodes = [];
let currentFilter = "all";
let sortDescending = false;
let searchDebounce = null;
let starred = loadStarred();

function loadStarred() {
  try {
    const stored = JSON.parse(localStorage.getItem(STARRED_KEY));
    return new Set(
      Array.isArray(stored) ? stored.filter(Number.isInteger) : [],
    );
  } catch {
    return new Set();
  }
}

function toggleStar(episodeNumber) {
  // Re-read first: another tab may have changed the list since this page
  // loaded, and writing back a stale copy would silently undo its stars.
  starred = loadStarred();
  if (!starred.delete(episodeNumber)) starred.add(episodeNumber);
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...starred]));
  } catch {
    // Storage blocked or full: the star still shows for this visit.
  }
}

function seasonKey(title) {
  return /^\(S2\)/.test(title) ? "s2" : "s1";
}

function isSpecial(title) {
  return /^Special\b/i.test(title);
}

function readerUrl(episodeNumber) {
  return `index.html?ep=${episodeNumber}`;
}

function formatNumber(value) {
  return value.toLocaleString("en-US");
}

// "1 panel", "2 panels".
function pluralize(count, noun) {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function setStat(element, value) {
  element.textContent = value;
  element.classList.remove("is-loading");
}

function validateEpisodes(manifest) {
  if (!Array.isArray(manifest?.episodes)) {
    throw new EpisodeFormatError("Archive index has no episode list");
  }
  const valid = manifest.episodes.filter(
    (entry) =>
      isListedEpisode(entry) &&
      Number.isInteger(entry.panelCount) &&
      entry.panelCount > 0,
  );
  if (!valid.length) {
    throw new EpisodeFormatError("Archive index has no usable episodes");
  }
  return valid;
}

function updateStats(list) {
  const totalPanels = list.reduce(
    (sum, episode) => sum + episode.panelCount,
    0,
  );
  const seasonsPresent = new Set(
    list.map((episode) => seasonKey(episode.title)),
  );
  setStat(statEpisodes, formatNumber(list.length));
  setStat(statPanels, formatNumber(totalPanels));
  setStat(statSeasons, formatNumber(seasonsPresent.size));
}

function renderSkeleton() {
  content.replaceChildren();
  resultsCount.hidden = true;

  const grid = el("div", "archive-grid");
  for (let i = 0; i < SKELETON_COUNT; i += 1) {
    const body = el("div", "ep-card__body");
    body.append(el("div", "skeleton-line"), el("div", "skeleton-line"));

    const card = el("div", "ep-card is-skeleton");
    card.setAttribute("aria-hidden", "true");
    card.append(el("div", "ep-card__thumb"), body);
    grid.append(card);
  }
  content.append(grid);
}

// The error and empty states share this layout: a heading, a sentence of
// detail, and one button.
function buildMessageCard(className, title, detail, buttonLabel, onClick) {
  const card = el("div", className);
  card.append(
    el("strong", null, title),
    el("p", null, detail),
    ghostButton(buttonLabel, onClick),
  );
  return card;
}

function renderErrorState(title, detail) {
  content.replaceChildren();
  resultsCount.hidden = true;

  const card = buildMessageCard(
    "archive-error__card",
    title,
    detail,
    "Try again",
    init,
  );
  card.setAttribute("role", "alert");
  content.append(card);
}

// A sibling of the card's <a>, not a child: a button can't nest inside a link.
function buildStarButton(episode) {
  const button = el("button", "ep-star");
  button.type = "button";
  button.setAttribute("aria-label", `Star ${episode.title}`);

  const icon = el("i");
  icon.setAttribute("aria-hidden", "true");
  button.append(icon);

  const sync = () => {
    const on = starred.has(episode.episode);
    button.setAttribute("aria-pressed", String(on));
    icon.className = on ? "fa-solid fa-star" : "fa-regular fa-star";
  };
  button.addEventListener("click", () => {
    toggleStar(episode.episode);
    if (currentFilter !== "starred") {
      sync();
      return;
    }
    // In the Starred view an un-starred episode no longer belongs: redraw,
    // then hand focus to the card that took its place so keyboard users
    // don't lose their spot when the button disappears.
    const index = [...content.querySelectorAll(".ep-star")].indexOf(button);
    renderResults();
    const remaining = content.querySelectorAll(".ep-star");
    remaining[Math.min(index, remaining.length - 1)]?.focus({
      preventScroll: true,
    });
  });
  sync();
  return button;
}

function buildCard(episode) {
  const special = isSpecial(episode.title);
  const panels = pluralize(episode.panelCount, "panel");

  const card = el("a", "ep-card");
  card.href = readerUrl(episode.episode);
  card.setAttribute(
    "aria-label",
    `${episode.title}, ${panels}${special ? ", special episode" : ""}`,
  );

  // The thumbnail is the episode's first panel.
  const image = el("img");
  image.src = panelUrl(episode.episode, panelFilename(0));
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => image.remove(), { once: true });

  const thumb = el("span", "ep-card__thumb");
  thumb.append(image);
  if (special) thumb.append(el("span", "ep-card__badge", "Special"));

  const body = el("span", "ep-card__body");
  body.append(
    el("span", "ep-card__title", episode.title),
    el("span", "ep-card__meta", panels),
  );
  card.append(thumb, body);

  const item = el("div", "ep-item");
  item.append(card, buildStarButton(episode));
  return item;
}

function buildGrid(list) {
  const grid = el("div", "archive-grid");
  grid.append(...list.map(buildCard));
  return grid;
}

function sortList(list) {
  const sorted = [...list].sort((a, b) => a.episode - b.episode);
  return sortDescending ? sorted.reverse() : sorted;
}

function matchesFilter(episode) {
  switch (currentFilter) {
    case "s1":
    case "s2":
      return seasonKey(episode.title) === currentFilter;
    case "special":
      return isSpecial(episode.title);
    case "starred":
      return starred.has(episode.episode);
    default:
      return true;
  }
}

// The search box's own value is the single source for the query, so a render
// never works from a stale copy while a debounced keystroke is still pending.
function searchQuery() {
  return searchInput.value.trim();
}

function matchesQuery(episode, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    String(episode.episode) === needle ||
    episode.title.toLowerCase().includes(needle)
  );
}

function renderEmptyState(query) {
  resultsCount.hidden = true;

  // Starred with nothing starred isn't a failed search: say how to star.
  const noStars =
    currentFilter === "starred" &&
    !query &&
    !episodes.some((episode) => starred.has(episode.episode));

  let detail = "Nothing in the archive matches this filter yet.";
  if (noStars) detail = "Tap the star on any episode to save it here.";
  else if (query) detail = `Nothing in the archive matches "${query}".`;

  content.append(
    buildMessageCard(
      "archive-empty",
      noStars ? "No starred episodes yet" : "No episodes match",
      detail,
      noStars ? "Browse all episodes" : "Clear search and filters",
      () => {
        searchInput.value = "";
        setActiveFilter("all");
        renderResults();
      },
    ),
  );
}

function renderGrouped(list) {
  resultsCount.hidden = true;

  const seasons = sortDescending ? [...SEASONS].reverse() : SEASONS;
  for (const { key, label } of seasons) {
    const inSeason = list.filter((episode) => seasonKey(episode.title) === key);
    if (!inSeason.length) continue;

    const header = el("div", "season-group__header");
    header.append(
      el("h2", null, label),
      el("span", "season-group__count", pluralize(inSeason.length, "episode")),
    );

    const section = el("section", "season-group");
    section.append(header, buildGrid(inSeason));
    content.append(section);
  }
}

function renderFlat(list) {
  resultsCount.hidden = false;
  resultsCount.textContent = pluralize(list.length, "episode");
  content.append(buildGrid(list));
}

function renderResults() {
  if (!episodes.length) return;
  content.replaceChildren();

  const query = searchQuery();
  const filtered = sortList(
    episodes.filter(
      (episode) => matchesFilter(episode) && matchesQuery(episode, query),
    ),
  );
  if (!filtered.length) {
    renderEmptyState(query);
  } else if (currentFilter === "all" && !query) {
    renderGrouped(filtered);
  } else {
    renderFlat(filtered);
  }
}

function setActiveFilter(key) {
  currentFilter = key;
  for (const button of filterButtons) {
    const active = button.dataset.season === key;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function enableControls() {
  controls.dataset.disabled = "false";
  for (const control of [searchInput, ...filterButtons, sortButton]) {
    control.disabled = false;
  }
}

function attachControlEvents() {
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(renderResults, SEARCH_DEBOUNCE_MS);
  });

  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      setActiveFilter(button.dataset.season);
      renderResults();
    });
  }

  sortButton.addEventListener("click", () => {
    sortDescending = !sortDescending;
    sortButton.setAttribute("aria-pressed", String(sortDescending));
    sortLabel.textContent = sortDescending ? "Newest first" : "Reading order";
    sortIcon.className = sortDescending
      ? "fa-solid fa-arrow-up-short-wide"
      : "fa-solid fa-arrow-down-short-wide";
    renderResults();
  });
}

async function init() {
  controls.dataset.disabled = "true";
  renderSkeleton();

  if (!navigator.onLine) {
    renderErrorState(
      "You're offline",
      "Reconnect to the internet, then try loading the archive again.",
    );
    return;
  }

  try {
    episodes = validateEpisodes(await fetchArchiveJson(MANIFEST_PATH));
    updateStats(episodes);
    enableControls();
    renderResults();
  } catch (error) {
    console.error(error);
    renderErrorState(
      "Couldn't load the archive",
      "A temporary problem interrupted the request to the archive index. Please try again.",
    );
  }
}

// Stars changed in another tab: pick them up without a reload.
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STARRED_KEY) return;
  starred = loadStarred();
  renderResults();
});

attachControlEvents();
init();
