// Reader: shows one episode as a vertical strip of panels, with pull-to-
// navigate between episodes, saved reading progress, and double-tap fullscreen
// on touch devices. Archive access and DOM helpers come from shared.js, which
// loads first.

// Pull-to-navigate. A pull travels PULL_THRESHOLD px to trigger navigation;
// each px of wheel delta or finger travel counts for a fraction of a px. Touch
// is below 1 so the pull has some resistance.
const PULL_THRESHOLD = 120;
const WHEEL_PULL_FACTOR = 0.35;
const TOUCH_PULL_FACTOR = 0.55;
// A wheel pull only starts once the wheel has been idle at the edge for
// WHEEL_ARM_DELAY, so momentum that merely carries the page to the edge doesn't
// navigate. It ends once the wheel has been idle for WHEEL_FINISH_DELAY.
const WHEEL_ARM_DELAY = 240; // ms
const WHEEL_FINISH_DELAY = 180; // ms
const WHEEL_LINE_HEIGHT = 16; // px per line, for wheels that report lines
// How close to the top or bottom of the page still counts as being at it.
const EDGE_TOLERANCE = 2; // px
// Pause between showing "Loading…" and leaving the page, so the label paints.
const NAVIGATION_DELAY = 120; // ms
// The reader is revealed once the first panel has decoded, or after this long.
const FIRST_PANEL_DECODE_TIMEOUT = 2500; // ms
// Touch-only gesture (bound to touchstart/touchend, not click/dblclick): two
// quick taps toggle fullscreen on any touch device, whatever the viewport size.
// These bound what counts as a single "tap" (quick, roughly stationary) and how
// close together two taps must land to be a double-tap.
const DOUBLE_TAP_MAX_INTERVAL = 300; // ms
const DOUBLE_TAP_MAX_DISTANCE = 24; // px
// Reading progress (see saveProgress): the localStorage key, and how long
// scrolling must pause before the position is written.
const PROGRESS_KEY = "hj:progress";
const PROGRESS_SAVE_DELAY = 300; // ms

// ArrowRight/ArrowLeft navigate to the next/previous episode.
const KEY_DIRECTIONS = { ArrowRight: "next", ArrowLeft: "prev" };

// Thrown when ep=latest can't be resolved to a real episode number (the
// manifest request failed, or the manifest has nothing usable in it). Separate
// from ArchiveRequestError/EpisodeFormatError so the viewer can avoid implying
// that the *link* was wrong: the person asked for "latest", not a specific
// episode.
class LatestEpisodeUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LatestEpisodeUnavailableError";
  }
}

const params = new URLSearchParams(location.search);
const epParam = params.get("ep");
const isLatestRequested = epParam === "latest";
const requestedEpisode = Number.parseInt(epParam || "1", 10);
// With ?ep=latest this starts as a placeholder; initializeViewer() replaces it
// with the newest episode's number before anything is fetched.
let episodeNumber = requestedEpisode > 0 ? requestedEpisode : 1;

const reader = document.querySelector(".reader");
const strip = document.getElementById("strip");
const episodeTitle = document.getElementById("episode-title");
const viewerState = document.getElementById("viewer-state");
const viewerStateTitle = document.getElementById("viewer-state-title");
const viewerStateDetail = document.getElementById("viewer-state-detail");
const viewerStateRetry = document.getElementById("viewer-state-retry");
const episodeEnd = document.getElementById("episode-end");
const episodeEndTitle = document.getElementById("episode-end-title");
const episodeEndDetail = document.getElementById("episode-end-detail");
const continueLink = document.getElementById("episode-end-continue");
const nextEpisodeTitle = document.getElementById("next-episode-title");

// Everything that differs between going to the previous and the next episode:
//   word      how the direction reads in the indicator's labels
//   offset    that episode's position relative to this one in the manifest
//   isAtEdge  whether the page is at the edge this direction pulls from
//   number    the episode to go to, or null when there isn't one
function createDirection(name, word, offset, isAtEdge) {
  const indicator = document.getElementById(`pull-${name}`);
  return {
    word,
    offset,
    isAtEdge,
    indicator,
    label: indicator.querySelector(".pull-indicator__label"),
    link: document.getElementById(`episode-end-${name}`),
    number: null,
  };
}

const directions = {
  prev: createDirection("prev", "previous", -1, isAtTop),
  next: createDirection("next", "next", 1, isAtBottom),
};

function otherDirection(name) {
  return name === "prev" ? "next" : "prev";
}

// Until the manifest says otherwise, the previous episode is assumed to be N-1.
function assumePreviousEpisode() {
  directions.prev.number = episodeNumber > 1 ? episodeNumber - 1 : null;
}

let pullDistance = 0;
let pullInput = null;
let pullDirection = null;
let touchY = null;
let wheelArmTimer = null;
let wheelFinishTimer = null;
let armedWheelDirection = null;
let isNavigating = false;
let tapStart = null; // { x, y, time } of the touch in progress
let lastTap = null; // { x, y, time } of the previous quick tap
let progressSaveTimer = null;
let progressDirty = false;

assumePreviousEpisode();

function updateScale() {
  if (!reader.clientWidth) return; // hidden or not laid out yet: avoid zoom: 0
  // The column width is the one --panel-width token in styles.css.
  const panelWidth = Number.parseFloat(
    getComputedStyle(strip).getPropertyValue("--panel-width"),
  );
  const scale = Math.min(reader.clientWidth / panelWidth, 1);
  // CSS zoom participates in layout, so the browser resolves pixel snapping in
  // the zoomed coordinate system. That avoids the subpixel seams that
  // transform: scale() produces, which composites images out of flow and rounds
  // each panel boundary independently. Zoom also drives the layout height
  // directly, so the reader needs no height override.
  strip.style.zoom = scale < 1 ? scale : "";
}

function setViewerState(title, detail, { canRetry = false } = {}) {
  viewerState.hidden = false;
  viewerState.classList.remove("is-hidden");
  viewerState.classList.toggle("is-error", canRetry);
  viewerState.setAttribute("role", canRetry ? "alert" : "status");
  viewerStateTitle.textContent = title;
  viewerStateDetail.textContent = detail;
  // While loading, only the thin loader is visible. The title and detail stay
  // in the DOM, visually hidden, so screen readers still hear "Opening episode"
  // via the live region; they're shown once there's an error and a retry to
  // offer.
  viewerStateTitle.classList.toggle("visually-hidden", !canRetry);
  viewerStateDetail.classList.toggle("visually-hidden", !canRetry);
  viewerStateRetry.hidden = !canRetry;
}

function showOpeningState() {
  setViewerState("Opening episode", "Preparing the panels for you.");
}

// Fades the overlay out (the transition on .viewer-state), then takes it out of
// layout once the fade has finished or been interrupted.
function dismissViewerState() {
  viewerState.classList.add("is-hidden");
  const fades = viewerState
    .getAnimations()
    .map((animation) => animation.finished);
  Promise.allSettled(fades).then(() => {
    if (viewerState.classList.contains("is-hidden")) viewerState.hidden = true;
  });
}

// The title and detail to show for an error, picked from what went wrong.
function describeViewerError(error) {
  if (!navigator.onLine) {
    return [
      "You're offline",
      "Reconnect to the internet, then try opening the episode again.",
    ];
  }
  if (error instanceof LatestEpisodeUnavailableError) {
    return [
      "Couldn't find the latest episode",
      "The archive index didn't load. Try again, or open a specific episode number directly.",
    ];
  }
  if (error instanceof ArchiveRequestError && error.status === 404) {
    return [
      "Episode unavailable",
      "This episode isn't in the archive yet, or the link may be incorrect.",
    ];
  }
  if (error instanceof EpisodeFormatError) {
    return [
      "Episode temporarily unavailable",
      "The archived episode is incomplete. Please try again after the next update.",
    ];
  }
  return [
    "Couldn't open this episode",
    "A temporary problem interrupted the archive. Please try again.",
  ];
}

function showViewerError(error) {
  reader.hidden = true;
  episodeEnd.hidden = true;
  const [title, detail] = describeViewerError(error);
  setViewerState(title, detail, { canRetry: true });
}

function validateEpisodeMetadata(metadata, expectedEpisode) {
  if (!metadata || typeof metadata !== "object") {
    throw new EpisodeFormatError("Episode metadata is not an object");
  }
  if (metadata.episode !== expectedEpisode) {
    throw new EpisodeFormatError("Episode number does not match the request");
  }
  if (typeof metadata.title !== "string" || !metadata.title.trim()) {
    throw new EpisodeFormatError("Episode title is missing");
  }
  if (!Array.isArray(metadata.panels) || metadata.panels.length === 0) {
    throw new EpisodeFormatError("Episode has no panels");
  }
  if (metadata.panelCount !== metadata.panels.length) {
    throw new EpisodeFormatError("Panel count does not match the panel map");
  }

  metadata.panels.forEach((panel, panelIndex) => {
    if (
      !panel ||
      panel.file !== panelFilename(panelIndex) ||
      !Number.isInteger(panel.width) ||
      panel.width <= 0 ||
      !Number.isInteger(panel.height) ||
      panel.height <= 0
    ) {
      throw new EpisodeFormatError(`Panel ${panelIndex + 1} is invalid`);
    }
  });
}

function createPanelUnavailable(panel, panelIndex) {
  const placeholder = el("div", "panel-unavailable");
  // Reserve the height the panel will have once loaded, so a retry doesn't
  // shift everything below it. This is the same aspect ratio the browser
  // applies to the real <img> from its width and height attributes, so the two
  // heights match exactly, even at the sub-pixel level.
  placeholder.style.aspectRatio = `${panel.width} / ${panel.height}`;
  placeholder.setAttribute("role", "group");
  placeholder.setAttribute("aria-label", `Panel ${panelIndex + 1} unavailable`);

  const retry = ghostButton("Retry panel", () => {
    placeholder.closest(".panel").replaceWith(createPanel(panel, panelIndex));
  });

  const content = el("div", "panel-unavailable__content");
  content.append(
    el("strong", null, `Panel ${panelIndex + 1} couldn't load`),
    el(
      "p",
      null,
      "The space is preserved so you can continue reading without losing your place.",
    ),
    retry,
  );
  placeholder.append(content);
  return placeholder;
}

// Adds the blurred ambient layer behind a panel. CSS positions it entirely
// (see .panel__glow), so nothing is measured or rebuilt on resize. It's only
// created once the sharp image has loaded, and reuses that image's URL: one
// network fetch per panel, and the glow can't load on a different schedule
// than its panel.
function attachGlow(wrapper, image) {
  const glow = el("img", "panel__glow");
  glow.alt = "";
  glow.decoding = "async";
  glow.src = image.currentSrc || image.src;
  wrapper.prepend(glow);

  // Wait for decode + one frame so the blur filter is composited before the
  // glow is revealed (avoids an unfiltered flash or artifacts).
  glow.decode().then(
    () => requestAnimationFrame(() => glow.classList.add("is-ready")),
    () => glow.remove(),
  );
}

function createPanel(panel, panelIndex) {
  const wrapper = el("div", "panel");

  const image = el("img", "panel__image");
  image.src = panelUrl(episodeNumber, panel.file);
  image.width = panel.width;
  image.height = panel.height;
  image.alt = "";
  image.loading = panelIndex === 0 ? "eager" : "lazy";
  image.decoding = "async";
  if (panelIndex === 0) image.fetchPriority = "high";
  image.addEventListener("load", () => attachGlow(wrapper, image), {
    once: true,
  });
  image.addEventListener(
    "error",
    () => image.replaceWith(createPanelUnavailable(panel, panelIndex)),
    { once: true },
  );

  wrapper.append(image);
  return wrapper;
}

// Renders every panel and returns the first panel's image.
function renderPanels(metadata) {
  const panels = metadata.panels.map(createPanel);
  episodeTitle.textContent = metadata.title;
  strip.setAttribute(
    "aria-label",
    `${metadata.title}, ${metadata.panelCount} visual panels`,
  );
  strip.replaceChildren(...panels);
  return panels[0].querySelector(".panel__image");
}

function isAtTop() {
  return window.scrollY <= EDGE_TOLERANCE;
}

function isAtBottom() {
  return (
    window.scrollY + window.innerHeight >=
    document.documentElement.scrollHeight - EDGE_TOLERANCE
  );
}

function pullLabel(name, progress, input) {
  const noun = `${directions[name].word} episode`;
  if (progress === 1) {
    return input === "touch"
      ? `Release for ${noun}`
      : `${noun[0].toUpperCase()}${noun.slice(1)} ready`;
  }
  return input === "wheel" ? `Keep scrolling for ${noun}` : `Pull for ${noun}`;
}

function setPullLabel(name, text) {
  const { label } = directions[name];
  if (label.textContent !== text) label.textContent = text;
}

function setIndicatorProgress(name, progress) {
  const { indicator } = directions[name];
  indicator.style.setProperty("--pull-progress", progress);
  indicator.classList.toggle("is-ready", progress === 1);
}

function setPullDistance(distance, input, name) {
  pullDistance = Math.max(0, Math.min(distance, PULL_THRESHOLD));
  pullInput = pullDistance > 0 ? input : null;
  pullDirection = pullDistance > 0 ? name : null;
  const progress = pullDistance / PULL_THRESHOLD;

  setIndicatorProgress(otherDirection(name), 0);
  setIndicatorProgress(name, progress);
  setPullLabel(name, pullLabel(name, progress, input));
}

function resetPull() {
  armedWheelDirection = null;
  pullDistance = 0;
  pullInput = null;
  pullDirection = null;
  setIndicatorProgress("prev", 0);
  setIndicatorProgress("next", 0);
}

// Drops a wheel pull in this direction, whether it's armed or already under
// way.
function cancelPull(name) {
  if (armedWheelDirection !== name && pullDirection !== name) return;
  window.clearTimeout(wheelArmTimer);
  resetPull();
}

function episodeUrl(number) {
  const url = new URL(location.href);
  url.searchParams.set("ep", String(number));
  return url.href;
}

function navigateTo(name) {
  const direction = directions[name];
  if (isNavigating || direction.number === null) return;

  isNavigating = true;
  const destination = episodeUrl(direction.number);
  direction.indicator.classList.add("is-loading");
  setPullLabel(name, `Loading ${direction.word} episode…`);
  window.setTimeout(() => location.assign(destination), NAVIGATION_DELAY);
}

function finishPull() {
  if (pullDistance >= PULL_THRESHOLD && pullDirection !== null) {
    navigateTo(pullDirection);
  } else {
    resetPull();
  }
}

function normalizeWheelDelta(event) {
  if (event.deltaMode === 1) return event.deltaY * WHEEL_LINE_HEIGHT;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function handleWheel(event) {
  if (isNavigating || event.deltaY === 0) return;

  const name = event.deltaY > 0 ? "next" : "prev";
  const direction = directions[name];
  cancelPull(otherDirection(name));

  if (direction.number === null || !direction.isAtEdge()) {
    cancelPull(name);
    return;
  }

  if (armedWheelDirection !== name) {
    window.clearTimeout(wheelArmTimer);
    wheelArmTimer = window.setTimeout(() => {
      if (direction.isAtEdge()) armedWheelDirection = name;
    }, WHEEL_ARM_DELAY);
    return;
  }

  event.preventDefault();
  setPullDistance(
    pullDistance + Math.abs(normalizeWheelDelta(event)) * WHEEL_PULL_FACTOR,
    "wheel",
    name,
  );
  window.clearTimeout(wheelFinishTimer);
  wheelFinishTimer = window.setTimeout(finishPull, WHEEL_FINISH_DELAY);
}

function handleTouchStart(event) {
  if (pullInput === "wheel") resetPull();
  if (event.touches.length !== 1) {
    touchY = null;
    resetPull();
    return;
  }
  touchY = event.touches[0].clientY;
}

function handleTouchMove(event) {
  if (touchY === null || event.touches.length !== 1 || isNavigating) return;

  const currentY = event.touches[0].clientY;
  const delta = touchY - currentY; // positive: finger moving up, toward "next"
  touchY = currentY;

  // A pull already under way keeps tracking the finger (and blocks page
  // scrolling) until it's released or pushed back to zero.
  if (pullDirection !== null) {
    event.preventDefault();
    const pullDelta = pullDirection === "next" ? delta : -delta;
    const newDistance =
      pullDistance + pullDelta * (pullDelta > 0 ? TOUCH_PULL_FACTOR : 1);
    if (newDistance <= 0) resetPull();
    else setPullDistance(newDistance, "touch", pullDirection);
    return;
  }

  if (delta === 0) return;
  const name = delta > 0 ? "next" : "prev";
  const direction = directions[name];
  if (direction.number === null || !direction.isAtEdge()) return;

  event.preventDefault();
  setPullDistance(Math.abs(delta) * TOUCH_PULL_FACTOR, "touch", name);
}

function handleTouchEnd() {
  if (touchY === null) return;
  touchY = null;
  finishPull();
}

function handleTouchCancel() {
  touchY = null;
  resetPull();
}

function isFullscreenSupported() {
  const root = document.documentElement;
  return Boolean(root.requestFullscreen ?? root.webkitRequestFullscreen);
}

function isFullscreenActive() {
  return Boolean(
    document.fullscreenElement ?? document.webkitFullscreenElement,
  );
}

function toggleFullscreen() {
  const root = document.documentElement;
  const exiting = isFullscreenActive();
  const target = exiting ? document : root;
  const change = exiting
    ? (document.exitFullscreen ?? document.webkitExitFullscreen)
    : (root.requestFullscreen ?? root.webkitRequestFullscreen);
  const action = exiting ? "exit" : "enter";
  // The prefixed versions return nothing rather than a promise.
  change
    ?.call(target)
    ?.catch?.((error) => console.warn(`Couldn't ${action} fullscreen:`, error));
}

function handleFullscreenTapStart(event) {
  if (event.touches.length !== 1) {
    tapStart = null;
    return;
  }
  const { clientX: x, clientY: y } = event.touches[0];
  tapStart = { x, y, time: event.timeStamp };
}

// Tracked independently of the pull-to-navigate gesture above: this only cares
// whether two quick, roughly stationary taps landed close together in time and
// space, not about scroll position or direction.
function handleFullscreenTapEnd(event) {
  const start = tapStart;
  tapStart = null;
  if (!start || !isFullscreenSupported()) return;

  // A double-tap on a control (retry button, continue link, ...) should only
  // trigger that control, not also toggle fullscreen.
  if (event.target.closest?.("button, a, input, textarea, select")) return;

  const touch = event.changedTouches[0];
  if (!touch) return;

  const isStationaryTap =
    Math.hypot(touch.clientX - start.x, touch.clientY - start.y) <
      DOUBLE_TAP_MAX_DISTANCE &&
    event.timeStamp - start.time < DOUBLE_TAP_MAX_INTERVAL;

  if (!isStationaryTap) {
    lastTap = null;
    return;
  }

  if (
    lastTap &&
    event.timeStamp - lastTap.time < DOUBLE_TAP_MAX_INTERVAL &&
    Math.hypot(start.x - lastTap.x, start.y - lastTap.y) <
      DOUBLE_TAP_MAX_DISTANCE
  ) {
    lastTap = null; // consumed, so a third fast tap starts a fresh pair
    toggleFullscreen();
    return;
  }

  lastTap = { x: start.x, y: start.y, time: event.timeStamp };
}

// Reading progress, saved per episode in localStorage as a 0-1 fraction of the
// strip's height (viewport top relative to the strip), so it survives a
// different window width. 1 means finished: reopening a finished episode
// starts at the top, same as an unread one.
function readProgressMap() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored
      : {};
  } catch {
    return {};
  }
}

function currentProgress() {
  const rect = reader.getBoundingClientRect();
  // End of the strip in view.
  if (rect.bottom <= window.innerHeight + EDGE_TOLERANCE) return 1;
  return Math.min(Math.max(-rect.top / rect.height, 0), 1);
}

function saveProgress() {
  window.clearTimeout(progressSaveTimer);
  // Only after the person has actually scrolled, so merely opening an episode
  // never overwrites what was saved.
  if (!progressDirty || reader.hidden) return;
  progressDirty = false;

  // Round before testing, so a nudge too small to matter is treated as "at the
  // top" (entry removed) instead of storing a 0.
  const progress = Math.round(currentProgress() * 1000) / 1000;
  const map = readProgressMap();
  if (progress > 0) map[episodeNumber] = progress;
  else delete map[episodeNumber];
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked or full: reading still works, progress just isn't kept.
  }
}

function queueProgressSave() {
  progressDirty = true;
  window.clearTimeout(progressSaveTimer);
  progressSaveTimer = window.setTimeout(saveProgress, PROGRESS_SAVE_DELAY);
}

function restoreProgress() {
  const progress = Number(readProgressMap()[episodeNumber]);
  if (!(progress > 0 && progress < 1)) return; // unread, finished, or junk
  const rect = reader.getBoundingClientRect();
  // "instant" because html has scroll-behavior: smooth, which would otherwise
  // animate the jump from the top.
  window.scrollTo({
    top: window.scrollY + rect.top + progress * rect.height,
    behavior: "instant",
  });
}

function handleScroll() {
  queueProgressSave();
  // Scrolling away from the edge drops a wheel pull that had armed there.
  if (armedWheelDirection && !directions[armedWheelDirection].isAtEdge()) {
    cancelPull(armedWheelDirection);
  }
}

function handleKeydown(event) {
  if (isNavigating) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.target.isContentEditable) return;

  const name = KEY_DIRECTIONS[event.key];
  if (!name || directions[name].number === null) return;
  event.preventDefault();
  navigateTo(name);
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") saveProgress();
}

// Going back to this page can restore it from the back/forward cache exactly
// as it was left mid-navigation. Undo the "Loading…" state so it's usable.
function handlePageShow(event) {
  if (!event.persisted) return;
  isNavigating = false;
  resetPull();
  for (const [name, direction] of Object.entries(directions)) {
    direction.indicator.classList.remove("is-loading");
    setPullLabel(name, pullLabel(name, 0));
  }
}

// Shows each direction's indicator and episode-end link when there's an episode
// to go to, and points the link at it.
function syncNavigation() {
  for (const { number, link, indicator } of Object.values(directions)) {
    link.hidden = number === null;
    indicator.hidden = number === null;
    if (number !== null) link.href = episodeUrl(number);
  }
}

function setEpisodeEndText(title, detail) {
  episodeEndTitle.textContent = title;
  episodeEndDetail.textContent = detail;
}

function configureEpisodeEnd(manifest, metadata) {
  episodeEnd.hidden = false;
  episodeEndTitle.hidden = false;
  continueLink.hidden = true;

  if (!Array.isArray(manifest?.episodes)) {
    // No manifest: keep the assumed previous episode and offer no next one.
    setEpisodeEndText(
      "Episode complete",
      "You've reached the end of this episode.",
    );
    syncNavigation();
    return;
  }

  const index = manifest.episodes.findIndex(
    (entry) => entry?.episode === episodeNumber,
  );
  if (index !== -1) {
    for (const direction of Object.values(directions)) {
      const neighbor = manifest.episodes[index + direction.offset];
      if (isListedEpisode(neighbor)) {
        direction.number = neighbor.episode;
      } else if (neighbor === undefined) {
        // The manifest has nothing on this side of the current episode.
        direction.number = null;
      }
    }
  }
  syncNavigation();

  if (directions.next.number === null) {
    setEpisodeEndText(
      "You're all caught up",
      "This is the latest episode currently in the archive.",
    );
    return;
  }

  // The "Up next" card replaces the heading. It stays in the DOM, hidden, to
  // name the section for screen readers (aria-labelledby).
  setEpisodeEndText("Episode complete", `You finished ${metadata.title}`);
  episodeEndTitle.hidden = true;
  nextEpisodeTitle.textContent = manifest.episodes[index + 1].title;
  continueLink.href = episodeUrl(directions.next.number);
  continueLink.hidden = false;
}

// archive.py writes totalEpisodes as the authoritative newest episode number
// in archive/episodes.json, so it's used directly instead of being re-derived.
function resolveLatestEpisodeNumber(manifest) {
  const total = manifest?.totalEpisodes;
  return Number.isInteger(total) && total > 0 ? total : null;
}

// Fetches the manifest and finds the newest episode in it. Anything that goes
// wrong becomes a LatestEpisodeUnavailableError.
async function resolveLatestEpisode() {
  try {
    const manifest = await fetchArchiveJson(MANIFEST_PATH);
    const episode = resolveLatestEpisodeNumber(manifest);
    if (episode === null) {
      throw new EpisodeFormatError("Archive manifest has no episodes listed");
    }
    return { manifest, episode };
  } catch (cause) {
    throw new LatestEpisodeUnavailableError(
      "Could not resolve the latest episode",
      { cause },
    );
  }
}

function attachViewerEvents() {
  window.addEventListener("resize", updateScale, { passive: true });
  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("touchstart", handleTouchStart, { passive: true });
  window.addEventListener("touchmove", handleTouchMove, { passive: false });
  window.addEventListener("touchend", handleTouchEnd, { passive: true });
  window.addEventListener("touchcancel", handleTouchCancel, { passive: true });
  window.addEventListener("touchstart", handleFullscreenTapStart, {
    passive: true,
  });
  window.addEventListener("touchend", handleFullscreenTapEnd, {
    passive: true,
  });
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("pagehide", saveProgress);
  window.addEventListener("pageshow", handlePageShow);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

async function initializeViewer() {
  let manifest = null;
  if (isLatestRequested) {
    setViewerState(
      "Finding the latest episode",
      "Checking the archive for the newest update.",
    );
    try {
      const latest = await resolveLatestEpisode();
      manifest = latest.manifest;
      episodeNumber = latest.episode;
    } catch (error) {
      console.error(error);
      showViewerError(error);
      return;
    }
    assumePreviousEpisode();
  }
  showOpeningState();

  const manifestRequest = manifest
    ? Promise.resolve(manifest)
    : fetchArchiveJson(MANIFEST_PATH).catch((error) => {
        console.warn("Episode navigation is unavailable:", error);
        return null;
      });

  try {
    const metadata = await fetchArchiveJson(episodeMapPath(episodeNumber));
    validateEpisodeMetadata(metadata, episodeNumber);
    document.title = metadata.title;

    const firstImage = renderPanels(metadata);
    reader.hidden = false;
    updateScale();
    restoreProgress();
    attachViewerEvents();
    syncNavigation();

    await Promise.race([
      firstImage.decode().catch(() => undefined),
      new Promise((resolve) =>
        window.setTimeout(resolve, FIRST_PANEL_DECODE_TIMEOUT),
      ),
    ]);
    dismissViewerState();

    configureEpisodeEnd(await manifestRequest, metadata);
  } catch (error) {
    console.error(error);
    showViewerError(error);
  }
}

viewerStateRetry.addEventListener("click", () => location.reload());
// Reading position is restored per episode (see restoreProgress); the
// browser's own scroll restoration on reload and back/forward would fight it.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
initializeViewer();
