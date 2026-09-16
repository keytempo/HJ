// Episode Archive script.
//
// This mirrors the data contract used by scripts.js (same BASE_URL, same
// map/manifest.json shape: { totalEpisodes, episodes: [{ episode, title,
// panelCount }] }) but only ever reads the manifest — it never opens an
// individual episode's panel map, so there's no reader state here at all.
// Reading order always means ascending by `episode`, and every link out to
// the reader uses `episode` (not the story-facing "Ep. N" number embedded
// in the title, which drifts from `episode` after the Special episode).

const BASE_URL = "https://raw.githubusercontent.com/keytempo/handjumper/main/";
const MANIFEST_PATH = "map/manifest.json";
const SKELETON_COUNT = 10;

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
let currentQuery = "";
let sortDescending = false;
let searchDebounce = null;

function seasonKey(title) {
  return /^\(S2\)/.test(title) ? "s2" : "s1";
}

function isSpecial(title) {
  return /^Special\b/i.test(title);
}

function thumbUrl(episodeNumber) {
  return `${BASE_URL}episodes/${episodeNumber}/001.webp`;
}

function readerUrl(episodeNumber) {
  return `index.html?ep=${episodeNumber}`;
}

function formatNumber(value) {
  return value.toLocaleString("en-US");
}

function setStat(element, value) {
  element.textContent = value;
  element.classList.remove("is-loading");
}

function validateEpisodes(manifest) {
  if (!manifest || !Array.isArray(manifest.episodes)) {
    throw new Error("Archive index has no episode list");
  }
  const valid = manifest.episodes.filter(
    (episode) =>
      episode &&
      Number.isInteger(episode.episode) &&
      episode.episode > 0 &&
      typeof episode.title === "string" &&
      episode.title.trim() &&
      Number.isInteger(episode.panelCount) &&
      episode.panelCount > 0,
  );
  if (!valid.length) {
    throw new Error("Archive index has no usable episodes");
  }
  return valid;
}

async function fetchManifest() {
  let response;
  try {
    response = await fetch(`${BASE_URL}${MANIFEST_PATH}`);
  } catch (error) {
    const wrapped = new Error("Archive request failed");
    wrapped.cause = error;
    throw wrapped;
  }
  if (!response.ok) {
    throw new Error(`Archive request failed with status ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    const wrapped = new Error("Archive index is not valid JSON");
    wrapped.cause = error;
    throw wrapped;
  }
}

function updateStats(list) {
  const totalPanels = list.reduce((sum, episode) => sum + episode.panelCount, 0);
  const seasonsPresent = new Set(list.map((episode) => seasonKey(episode.title))).size;
  setStat(statEpisodes, formatNumber(list.length));
  setStat(statPanels, formatNumber(totalPanels));
  setStat(statSeasons, formatNumber(seasonsPresent));
}

function clearContent() {
  content.replaceChildren();
}

function renderSkeleton() {
  clearContent();
  resultsCount.hidden = true;

  const grid = document.createElement("div");
  grid.className = "archive-grid";

  for (let i = 0; i < SKELETON_COUNT; i += 1) {
    const card = document.createElement("div");
    card.className = "ep-card is-skeleton";
    card.setAttribute("aria-hidden", "true");

    const thumb = document.createElement("div");
    thumb.className = "ep-card__thumb";

    const body = document.createElement("div");
    body.className = "ep-card__body";
    const lineOne = document.createElement("div");
    lineOne.className = "skeleton-line";
    const lineTwo = document.createElement("div");
    lineTwo.className = "skeleton-line";
    body.append(lineOne, lineTwo);

    card.append(thumb, body);
    grid.append(card);
  }

  content.append(grid);
}

function renderErrorState(title, detail) {
  clearContent();
  resultsCount.hidden = true;

  const card = document.createElement("div");
  card.className = "archive-error__card";
  card.setAttribute("role", "alert");

  const heading = document.createElement("strong");
  heading.textContent = title;

  const message = document.createElement("p");
  message.textContent = detail;

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn--ghost";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => init());

  card.append(heading, message, retry);
  content.append(card);
}

function buildCard(episode) {
  const card = document.createElement("a");
  card.className = "ep-card";
  card.href = readerUrl(episode.episode);

  const special = isSpecial(episode.title);
  card.setAttribute(
    "aria-label",
    `${episode.title}, ${formatNumber(episode.panelCount)} panels${special ? ", special episode" : ""}`,
  );

  const thumb = document.createElement("span");
  thumb.className = "ep-card__thumb";

  const image = document.createElement("img");
  image.src = thumbUrl(episode.episode);
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => image.remove(), { once: true });
  thumb.append(image);

  if (special) {
    const badge = document.createElement("span");
    badge.className = "ep-card__badge";
    badge.textContent = "Special";
    thumb.append(badge);
  }

  const body = document.createElement("span");
  body.className = "ep-card__body";

  const title = document.createElement("span");
  title.className = "ep-card__title";
  title.textContent = episode.title;

  const meta = document.createElement("span");
  meta.className = "ep-card__meta";
  const panelWord = episode.panelCount === 1 ? "panel" : "panels";
  meta.textContent = `${formatNumber(episode.panelCount)} ${panelWord}`;

  body.append(title, meta);
  card.append(thumb, body);
  return card;
}

function sortList(list) {
  const sorted = [...list].sort((a, b) => a.episode - b.episode);
  return sortDescending ? sorted.reverse() : sorted;
}

function matchesFilter(episode) {
  if (currentFilter === "s1") return seasonKey(episode.title) === "s1";
  if (currentFilter === "s2") return seasonKey(episode.title) === "s2";
  if (currentFilter === "special") return isSpecial(episode.title);
  return true;
}

function matchesQuery(episode) {
  const query = currentQuery.trim().toLowerCase();
  if (!query) return true;
  if (String(episode.episode) === query) return true;
  return episode.title.toLowerCase().includes(query);
}

function renderEmptyState() {
  resultsCount.hidden = true;

  const empty = document.createElement("div");
  empty.className = "archive-empty";

  const heading = document.createElement("strong");
  heading.textContent = "No episodes match";

  const detail = document.createElement("p");
  const query = currentQuery.trim();
  detail.textContent = query
    ? `Nothing in the archive matches "${query}".`
    : "Nothing in the archive matches this filter yet.";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn btn--ghost";
  clear.textContent = "Clear search and filters";
  clear.addEventListener("click", () => {
    currentQuery = "";
    searchInput.value = "";
    setActiveFilter("all");
    renderResults();
  });

  empty.append(heading, detail, clear);
  content.append(empty);
}

function renderGrouped(list) {
  resultsCount.hidden = true;

  const groups = [
    { key: "s1", label: "Season One" },
    { key: "s2", label: "Season Two" },
  ];

  groups.forEach(({ key, label }) => {
    const inGroup = list.filter((episode) => seasonKey(episode.title) === key);
    if (!inGroup.length) return;

    const section = document.createElement("section");
    section.className = "season-group";

    const header = document.createElement("div");
    header.className = "season-group__header";

    const heading = document.createElement("h2");
    heading.textContent = label;

    const count = document.createElement("span");
    count.className = "season-group__count";
    count.textContent = `${inGroup.length} episode${inGroup.length === 1 ? "" : "s"}`;

    header.append(heading, count);

    const grid = document.createElement("div");
    grid.className = "archive-grid";
    inGroup.forEach((episode) => grid.append(buildCard(episode)));

    section.append(header, grid);
    content.append(section);
  });
}

function renderFlat(list) {
  resultsCount.hidden = false;
  resultsCount.textContent = `${list.length} episode${list.length === 1 ? "" : "s"}`;

  const grid = document.createElement("div");
  grid.className = "archive-grid";
  list.forEach((episode) => grid.append(buildCard(episode)));
  content.append(grid);
}

function renderResults() {
  if (!episodes.length) return;
  clearContent();

  const filtered = sortList(episodes.filter((episode) => matchesFilter(episode) && matchesQuery(episode)));
  if (!filtered.length) {
    renderEmptyState();
    return;
  }

  const isDefaultView = currentFilter === "all" && !currentQuery.trim();
  if (isDefaultView) {
    renderGrouped(filtered);
  } else {
    renderFlat(filtered);
  }
}

function setActiveFilter(key) {
  currentFilter = key;
  filterButtons.forEach((button) => {
    const active = button.dataset.season === key;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function enableControls() {
  controls.dataset.disabled = "false";
  searchInput.disabled = false;
  filterButtons.forEach((button) => {
    button.disabled = false;
  });
  sortButton.disabled = false;
}

function attachControlEvents() {
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      currentQuery = searchInput.value;
      renderResults();
    }, 120);
  });

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveFilter(button.dataset.season);
      renderResults();
    });
  });

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
    const manifest = await fetchManifest();
    episodes = validateEpisodes(manifest);
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

attachControlEvents();
init();
