// Shared column width every panel is displayed at (see styles.css
// --panel-width), regardless of that panel's own native resolution —
// height:auto in CSS renormalizes each panel to this width using its own
// aspect ratio, so panels are free to have differing native widths.
const PANEL_WIDTH = 800;
const PULL_THRESHOLD = 120;
const WHEEL_ARM_DELAY = 240;
const WHEEL_FINISH_DELAY = 180;
// .reader is full-bleed at and below this width (see styles.css), so the
// ambient glow would be entirely hidden behind the panels — skip building
// it at all below this width rather than pay for work no one can see.
const GLOW_MIN_VIEWPORT = PANEL_WIDTH;
// px of soft overlap between one panel's glow and the next, so consecutive
// glows blend into each other instead of showing a hard seam.
const GLOW_OVERLAP = 120;
// Touch-only gesture (bound to touchstart/touchend below, not click/dblclick):
// two quick taps toggles fullscreen, on any touch device regardless of
// viewport size. These bound what counts as a single "tap" (quick, roughly
// stationary) and how close together in time two taps must land to count as
// a double-tap rather than two unrelated taps.
const DOUBLE_TAP_MAX_INTERVAL = 300; // ms
const DOUBLE_TAP_MAX_DISTANCE = 24; // px

class ArchiveRequestError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ArchiveRequestError";
    this.status = status;
  }
}

class EpisodeFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "EpisodeFormatError";
  }
}

// Thrown specifically when ep=latest can't be resolved to a real episode
// number (manifest request failed, or the manifest has nothing usable in
// it). Kept distinct from ArchiveRequestError/EpisodeFormatError so the
// viewer can show messaging that doesn't imply the *link* was wrong — the
// user asked for "latest", not a specific episode.
class LatestEpisodeUnavailableError extends ArchiveRequestError {
  constructor(message) {
    super(message);
    this.name = "LatestEpisodeUnavailableError";
  }
}

const query = new URLSearchParams(location.search);
const epParam = query.get("ep");
const isLatestRequested = epParam === "latest";
const requestedEpisode = Number.parseInt(epParam || "1", 10);
// When "latest" is requested this starts as a placeholder; initializeViewer()
// resolves it to the real newest episode number before it's used for any
// fetch or image path, so nothing downstream needs to know about "latest".
let episodeNumber =
  Number.isInteger(requestedEpisode) && requestedEpisode > 0
    ? requestedEpisode
    : 1;

const reader = document.querySelector(".reader");
const strip = document.getElementById("strip");
const episodeTitle = document.getElementById("episode-title");
const ambient = document.getElementById("ambient");
const viewerState = document.getElementById("viewer-state");
const viewerStateTitle = document.getElementById("viewer-state-title");
const viewerStateDetail = document.getElementById("viewer-state-detail");
const viewerStateRetry = document.getElementById("viewer-state-retry");
const episodeEnd = document.getElementById("episode-end");
const episodeEndEyebrow = document.getElementById("episode-end-eyebrow");
const episodeEndTitle = document.getElementById("episode-end-title");
const episodeEndDetail = document.getElementById("episode-end-detail");
const continueLink = document.getElementById("episode-end-continue");
const prevEpisodeLink = document.getElementById("episode-end-prev");
const nextEpisodeLink = document.getElementById("episode-end-next");
const nextEpisodeTitle = document.getElementById("next-episode-title");
const nextEpisodeIndicator = document.getElementById("next-episode");
const nextEpisodeLabel = nextEpisodeIndicator.querySelector(
  ".next-episode__label",
);

let nextEpisodeNumber = null;
let pullDistance = 0;
let pullInput = null;
let touchY = null;
let wheelArmTimer = null;
let wheelFinishTimer = null;
let isWheelPullArmed = false;
let isNavigating = false;
let resizeFrame = null;
let tapStartX = null;
let tapStartY = null;
let tapStartTime = 0;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
// The two lookahead observers driving panel preloading (see setupPreloading
// below). Held at module scope so a later episode-end glow rebuild, a
// resize, etc. never need to touch them — they're created once per episode
// load and simply left to run.
let farObserver = null;
let nearObserver = null;

function panelImageUrl(panel) {
  return `episodes/${episodeNumber}/${panel.file}`;
}

function updateScale() {
  if (reader.hidden) return;
  if (!reader.clientWidth) return; // not laid out yet — avoid zoom: 0
  const scale = Math.min(reader.clientWidth / PANEL_WIDTH, 1);
  // CSS zoom participates in layout, so the browser resolves pixel snapping
  // in the zoomed coordinate system. This eliminates the subpixel seams that
  // appear with transform: scale(), which composites images out-of-flow and
  // rounds each panel boundary independently. reader.style.height also no
  // longer needs a manual override — zoom drives the layout height directly.
  strip.style.zoom = scale < 1 ? scale : "";
  reader.style.height = "";
}

// setViewerState is now exclusively the error-reporting path — see
// dismissViewerState below for the (silent, textless) happy path. Errors are
// the one case in the initial-load flow where the person genuinely needs to
// read something and possibly act on it (retry), so the full card treatment
// (see styles.css .is-error) is reserved for this.
function setViewerState(title, detail, { canRetry = false } = {}) {
  viewerState.hidden = false;
  viewerState.classList.remove("is-hidden");
  viewerState.classList.toggle("is-error", canRetry);
  viewerState.setAttribute("role", canRetry ? "alert" : "status");
  viewerStateTitle.textContent = title;
  viewerStateDetail.textContent = detail;
  viewerStateTitle.classList.remove("visually-hidden");
  viewerStateDetail.classList.remove("visually-hidden");
  viewerStateRetry.hidden = !canRetry;
}

function dismissViewerState() {
  viewerState.classList.add("is-hidden");
  window.setTimeout(() => {
    if (viewerState.classList.contains("is-hidden")) viewerState.hidden = true;
  }, 260);
}

function showViewerError(error) {
  reader.hidden = true;
  episodeEnd.hidden = true;
  clearAmbientGlow();

  if (!navigator.onLine) {
    setViewerState(
      "You're offline",
      "Reconnect to the internet, then try opening the episode again.",
      { canRetry: true },
    );
    return;
  }

  if (error instanceof LatestEpisodeUnavailableError) {
    setViewerState(
      "Couldn't find the latest episode",
      "The archive index didn't load. Try again, or open a specific episode number directly.",
      { canRetry: true },
    );
    return;
  }

  if (error instanceof ArchiveRequestError && error.status === 404) {
    setViewerState(
      "Episode unavailable",
      "This episode isn't in the archive yet, or the link may be incorrect.",
      { canRetry: true },
    );
    return;
  }

  if (error instanceof EpisodeFormatError) {
    setViewerState(
      "Episode temporarily unavailable",
      "The archived episode is incomplete. Please try again after the next update.",
      { canRetry: true },
    );
    return;
  }

  setViewerState(
    "Couldn't open this episode",
    "A temporary problem interrupted the archive. Please try again.",
    { canRetry: true },
  );
}

function validateEpisodeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new EpisodeFormatError("Episode metadata is not an object");
  }
  if (metadata.episode !== episodeNumber) {
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
    const expectedFilename = `${String(panelIndex + 1).padStart(3, "0")}.webp`;
    if (
      !panel ||
      panel.file !== expectedFilename ||
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
  const placeholder = document.createElement("div");
  placeholder.className = "panel-unavailable";
  // Reserve space at the height this panel will actually render at once
  // loaded — every panel displays at the shared PANEL_WIDTH column
  // regardless of its own native width, so a retry doesn't shift
  // everything below it. Left unrounded: this is the exact same formula
  // the browser uses internally for height:auto on a real <img>, so there
  // is zero discrepancy (not even sub-pixel) between this and what the
  // successfully-loaded image renders at.
  placeholder.style.height = `${(panel.height / panel.width) * PANEL_WIDTH}px`;
  placeholder.setAttribute("role", "group");
  placeholder.setAttribute("aria-label", `Panel ${panelIndex + 1} unavailable`);

  const content = document.createElement("div");
  content.className = "panel-unavailable__content";

  const title = document.createElement("strong");
  title.textContent = `Panel ${panelIndex + 1} couldn't load`;

  const detail = document.createElement("p");
  detail.textContent =
    "The space is preserved so you can continue reading without losing your place.";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry panel";
  retry.addEventListener("click", () => {
    // A retry is an explicit, immediate request — it bypasses the ahead-of-
    // reader preload pipeline entirely and starts loading right away rather
    // than waiting to be observed.
    const replacement = createPanelImage(panel, panelIndex);
    replacement.fetchPriority = "high";
    beginLoadingPanel(replacement);
    replacement.decode?.().catch(() => undefined);
    placeholder.replaceWith(replacement);
    // A panel's own layout position changed, so the glow layout is rebuilt.
    // This is a one-off response to the click, not a scroll-driven update.
    buildAmbientGlow();
  });

  content.append(title, detail, retry);
  placeholder.append(content);
  return placeholder;
}

function createPanelImage(panel, panelIndex) {
  const image = document.createElement("img");
  image.width = panel.width;
  image.height = panel.height;
  image.alt = "";
  image.decoding = "async";
  image.draggable = false;
  // Lets the browser skip layout/paint work for panels far outside the
  // reading position (long episodes can have a great many of these) without
  // any visible jump when they scroll into range — contain-intrinsic-size is
  // set to the exact box this image renders at once loaded, the same
  // formula used for the unavailable-panel placeholder above, so there is
  // nothing for content-visibility to reconcile when it switches a panel
  // back to normal rendering. Unsupported browsers simply ignore both
  // properties and always render normally.
  image.style.containIntrinsicSize = `${PANEL_WIDTH}px ${(panel.height / panel.width) * PANEL_WIDTH}px`;
  // Referenced by the preloader (beginLoadingPanel/preparePanelForDisplay)
  // and by the retry handler above — keeps every piece of code that needs
  // this panel's file/dimensions working directly off the element itself
  // instead of threading a second array around.
  image._panel = panel;

  // The very first panel is the only one that can't wait on any lookahead
  // margin — it's what the person sees the instant the episode opens, so it
  // loads immediately and at the browser's highest fetch priority. Every
  // other panel is intentionally left without a src here; setupPreloading
  // assigns it once this panel is far enough ahead of the reading position
  // to be worth fetching (see below).
  if (panelIndex === 0) {
    image.fetchPriority = "high";
    image.src = panelImageUrl(panel);
  }

  image.addEventListener(
    "error",
    () => image.replaceWith(createPanelUnavailable(panel, panelIndex)),
    { once: true },
  );
  return image;
}

function renderPanels(metadata) {
  const panels = document.createDocumentFragment();
  const images = [];

  metadata.panels.forEach((panel, panelIndex) => {
    const image = createPanelImage(panel, panelIndex);
    images.push(image);
    panels.append(image);
  });

  episodeTitle.textContent = metadata.title;
  strip.setAttribute(
    "aria-label",
    `${metadata.title}, ${metadata.panelCount} visual panels`,
  );
  strip.setAttribute("role", "group");
  strip.replaceChildren(panels);
  return images;
}

// ---------------------------------------------------------------------
// Ahead-of-reader panel preloading.
//
// Native `loading="lazy"` on an <img> hands the browser a black box: it
// decides how far ahead of the viewport to start fetching, and in practice
// that's nowhere near far enough to make a panel feel "already there" by
// the time normal reading reaches it. IntersectionObserver is the native
// primitive for "tell me when this approaches the viewport" — using it
// directly, with a lookahead margin this code controls, gets the actual
// requirement (ready before reached) rather than the smaller guarantee
// native lazy-loading offers (starts loading eventually).
//
// Two tiers, deliberately kept independent of each other:
//   - far:  starts the network fetch early, well before the panel is
//           actually needed. Bytes only — no decode is forced, since
//           decoding a panel that's still many screens away would spend
//           CPU/memory on something that isn't imminent.
//   - near: forces a decode (cheap/instant if the far tier already fetched
//           the bytes, since decode() just resolves against what's already
//           in cache) shortly before the panel would actually be reached,
//           so it's genuinely pixel-ready and not just downloaded.
//
// Both margins are expressed in viewport heights rather than a fixed pixel
// or panel count, and the far margin narrows on constrained connections —
// so the window adapts to the device/session instead of being an arbitrary
// constant. Fast scrolling doesn't need separate handling: intersection
// observers fire as soon as an element crosses the (generous) threshold
// regardless of how quickly it got there, with no scroll listener or
// per-frame polling involved.
// ---------------------------------------------------------------------

function preloadWindow() {
  const viewportHeight = window.innerHeight || 800;
  const connection = navigator.connection;
  const isConstrained =
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g";
  return {
    near: viewportHeight,
    far: isConstrained ? viewportHeight * 1.5 : viewportHeight * 4,
  };
}

function beginLoadingPanel(image) {
  if (image.src) return; // already started (or is the eager first panel)
  image.src = panelImageUrl(image._panel);
}

function preparePanelForDisplay(image) {
  beginLoadingPanel(image);
  image.decode?.().catch(() => undefined); // failures are handled by the element's own error listener
}

function teardownPreloading() {
  farObserver?.disconnect();
  nearObserver?.disconnect();
  farObserver = null;
  nearObserver = null;
}

function setupPreloading(images) {
  teardownPreloading();

  // No IntersectionObserver support: fall back to loading everything
  // immediately rather than leaving every panel past the first permanently
  // unloaded. Rare in practice, but correctness here matters more than the
  // preload refinement above.
  if (!("IntersectionObserver" in window)) {
    images.forEach((image, index) => {
      if (index === 0) return;
      beginLoadingPanel(image);
    });
    return;
  }

  const { near, far } = preloadWindow();

  farObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        beginLoadingPanel(entry.target);
        farObserver.unobserve(entry.target);
      });
    },
    { rootMargin: `0px 0px ${far}px 0px` },
  );

  nearObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.fetchPriority = "high";
        preparePanelForDisplay(entry.target);
        nearObserver.unobserve(entry.target);
      });
    },
    { rootMargin: `0px 0px ${near}px 0px` },
  );

  images.forEach((image, index) => {
    if (index === 0) return; // already loaded eagerly
    farObserver.observe(image);
    nearObserver.observe(image);
  });
}

function ambientGlowSupported() {
  return window.innerWidth > GLOW_MIN_VIEWPORT;
}

function clearAmbientGlow() {
  ambient.replaceChildren();
  ambient.style.height = "";
}

// Builds one glow layer per panel, each pinned at that panel's own document
// offset. Positions are measured once here (and re-measured on resize, and
// once more after the episode-end section becomes visible — see below —
// since both are real layout changes) — never on scroll. Once placed, a
// glow element doesn't move relative to its panel again: both are ordinary
// page content now, so the browser scrolls them together for free.
//
// The final panel's glow is a special case: it's stretched all the way down
// to the true bottom of the document (not just its own panel + overlap), so
// the atmosphere carries through the episode-end section instead of cutting
// off partway through it. Calling this again once episode-end has its real,
// final height (configureEpisodeEnd does so) is what makes that stretch
// reach the actual end of the page rather than wherever the document
// happened to end while episode-end was still hidden.
function buildAmbientGlow() {
  clearAmbientGlow();
  if (!ambientGlowSupported()) return;

  const images = [...strip.querySelectorAll("img")];
  if (!images.length) return;

  const scrollY = window.scrollY;
  const documentHeight = document.documentElement.scrollHeight;
  const layers = document.createDocumentFragment();

  images.forEach((image, index) => {
    const bounds = image.getBoundingClientRect();
    const top = bounds.top + scrollY - GLOW_OVERLAP;
    // The last glow's bottom edge is made to land exactly at documentHeight
    // (rather than the usual +GLOW_OVERLAP past its own panel) specifically
    // so it lines up with ambient's own height below with nothing left to
    // clip — its mask (see .ambient__glow--tail in styles.css) finishes
    // fading to transparent a little before that edge regardless.
    const isLast = index === images.length - 1;
    const height = isLast
      ? documentHeight - top
      : bounds.height + GLOW_OVERLAP * 2;

    const glow = document.createElement("img");
    glow.className = isLast ? "ambient__glow ambient__glow--tail" : "ambient__glow";
    glow.alt = "";
    glow.loading = "lazy"; // defers the fetch/decode until it nears the viewport — native, no scroll listener involved
    glow.decoding = "async";
    glow.style.top = `${top}px`;
    glow.style.height = `${height}px`;
    glow.addEventListener("error", () => glow.remove(), { once: true });
    // Deliberately panelImageUrl(image._panel) rather than image.currentSrc/
    // image.src: panels beyond the first don't get their own src assigned
    // until the preloader reaches them (see setupPreloading), but the glow
    // is allowed to point at a panel's image before that panel's own <img>
    // has started loading — its native loading="lazy" above defers the
    // actual fetch until this layer nears the viewport regardless, the same
    // deferral every glow layer has always relied on.
    glow.src = panelImageUrl(image._panel);
    layers.append(glow);
  });

  ambient.append(layers);
  ambient.style.height = `${documentHeight}px`;
}

function isAtBottom() {
  return (
    window.scrollY + window.innerHeight >=
    document.documentElement.scrollHeight - 2
  );
}

function setPullLabel(label) {
  if (nextEpisodeLabel.textContent !== label) {
    nextEpisodeLabel.textContent = label;
  }
}

function setPullDistance(distance, input) {
  pullDistance = Math.max(0, Math.min(distance, PULL_THRESHOLD));
  pullInput = pullDistance > 0 ? input : null;
  const progress = pullDistance / PULL_THRESHOLD;

  nextEpisodeIndicator.style.setProperty("--pull-progress", progress);
  nextEpisodeIndicator.classList.toggle("is-ready", progress === 1);

  if (progress === 1) {
    setPullLabel(
      input === "touch" ? "Release for next episode" : "Next episode ready",
    );
  } else {
    setPullLabel(
      input === "wheel"
        ? "Keep scrolling for next episode"
        : "Pull for next episode",
    );
  }
}

function resetPull() {
  setPullDistance(0, null);
}

function episodeUrl(number) {
  const url = new URL(location.href);
  url.searchParams.set("ep", String(number));
  return url;
}

function nextEpisodeUrl() {
  return episodeUrl(nextEpisodeNumber);
}

function navigateToNextEpisode() {
  if (isNavigating || nextEpisodeNumber === null) return;

  isNavigating = true;
  nextEpisodeIndicator.classList.add("is-loading");
  setPullLabel("Loading next episode…");
  window.setTimeout(() => location.assign(nextEpisodeUrl()), 120);
}

function finishPull() {
  if (pullDistance >= PULL_THRESHOLD) navigateToNextEpisode();
  else resetPull();
}

function normalizeWheelDelta(event) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function handleWheel(event) {
  if (nextEpisodeNumber === null || isNavigating) return;

  if (!isAtBottom() || event.deltaY <= 0) {
    isWheelPullArmed = false;
    window.clearTimeout(wheelArmTimer);
    resetPull();
    return;
  }

  if (!isWheelPullArmed) {
    window.clearTimeout(wheelArmTimer);
    wheelArmTimer = window.setTimeout(() => {
      isWheelPullArmed = isAtBottom();
    }, WHEEL_ARM_DELAY);
    return;
  }

  event.preventDefault();
  setPullDistance(pullDistance + normalizeWheelDelta(event) * 0.35, "wheel");
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
  if (
    touchY === null ||
    event.touches.length !== 1 ||
    nextEpisodeNumber === null ||
    isNavigating
  ) {
    return;
  }

  const currentY = event.touches[0].clientY;
  const delta = touchY - currentY;
  touchY = currentY;

  if (isAtBottom() && delta > 0) {
    event.preventDefault();
    setPullDistance(pullDistance + delta * 0.55, "touch");
  } else if (pullDistance > 0) {
    event.preventDefault();
    setPullDistance(pullDistance + delta, "touch");
  }
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
  const doc = document.documentElement;
  return !!(
    doc.requestFullscreen ||
    doc.webkitRequestFullscreen ||
    doc.mozRequestFullScreen ||
    doc.msRequestFullscreen
  );
}

function isFullscreenActive() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

function toggleFullscreen() {
  if (isFullscreenActive()) {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;
    exit?.call(document)?.catch?.((error) =>
      console.warn("Couldn't exit fullscreen:", error),
    );
    return;
  }

  const doc = document.documentElement;
  const request =
    doc.requestFullscreen ||
    doc.webkitRequestFullscreen ||
    doc.mozRequestFullScreen ||
    doc.msRequestFullscreen;
  request?.call(doc)?.catch?.((error) =>
    console.warn("Couldn't enter fullscreen:", error),
  );
}

function handleFullscreenTapStart(event) {
  if (event.touches.length !== 1) {
    tapStartX = null;
    return;
  }
  tapStartX = event.touches[0].clientX;
  tapStartY = event.touches[0].clientY;
  tapStartTime = event.timeStamp;
}

// Tracked independently of the pull-to-navigate gesture above — this only
// cares whether two quick, roughly-stationary taps landed close together in
// time and space, not about scroll position or direction.
function handleFullscreenTapEnd(event) {
  if (tapStartX === null) return;
  const startX = tapStartX;
  const startY = tapStartY;
  const startTime = tapStartTime;
  tapStartX = null;

  if (!isFullscreenSupported()) return;

  // A double-tap on a control (retry button, continue link, ...) should
  // only trigger that control, not also toggle fullscreen.
  if (event.target.closest?.("button, a, input, textarea, select")) return;

  const touch = event.changedTouches[0];
  if (!touch) return;

  const dx = touch.clientX - startX;
  const dy = touch.clientY - startY;
  const isStationaryTap =
    Math.hypot(dx, dy) < DOUBLE_TAP_MAX_DISTANCE &&
    event.timeStamp - startTime < DOUBLE_TAP_MAX_INTERVAL;

  if (!isStationaryTap) {
    lastTapTime = 0;
    return;
  }

  const sinceLastTap = event.timeStamp - lastTapTime;
  const driftFromLastTap = Math.hypot(startX - lastTapX, startY - lastTapY);

  if (
    lastTapTime &&
    sinceLastTap < DOUBLE_TAP_MAX_INTERVAL &&
    driftFromLastTap < DOUBLE_TAP_MAX_DISTANCE
  ) {
    lastTapTime = 0; // consumed, so a third fast tap starts a fresh pair
    toggleFullscreen();
    return;
  }

  lastTapTime = event.timeStamp;
  lastTapX = startX;
  lastTapY = startY;
}

function handleScroll() {
  if (!isAtBottom()) {
    isWheelPullArmed = false;
    window.clearTimeout(wheelArmTimer);
    resetPull();
  }
}

function handleResize() {
  window.cancelAnimationFrame(resizeFrame);
  resizeFrame = window.requestAnimationFrame(() => {
    updateScale();
    buildAmbientGlow();
  });
}

function handleKeydown(event) {
  if (isNavigating) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.target.isContentEditable) return;

  if (event.key === "ArrowRight" && nextEpisodeNumber !== null) {
    event.preventDefault();
    navigateToNextEpisode();
  } else if (event.key === "ArrowLeft" && episodeNumber > 1) {
    event.preventDefault();
    isNavigating = true;
    location.assign(episodeUrl(episodeNumber - 1));
  }
}

function configureEpisodeEnd(manifest, metadata) {
  episodeEnd.hidden = false;
  continueLink.hidden = true;
  episodeEndEyebrow.hidden = false;
  if (nextEpisodeLink) nextEpisodeLink.hidden = true;

  if (prevEpisodeLink) {
    prevEpisodeLink.hidden = episodeNumber <= 1;
    if (!prevEpisodeLink.hidden) {
      prevEpisodeLink.href = episodeUrl(episodeNumber - 1);
    }
  }

  if (!manifest || !Array.isArray(manifest.episodes)) {
    episodeEndTitle.textContent = "Episode complete";
    episodeEndDetail.textContent = "You've reached the end of this episode.";
    return;
  }

  const currentEpisodeIndex = manifest.episodes.findIndex(
    (episode) => episode.episode === episodeNumber,
  );
  const followingEpisode = manifest.episodes[currentEpisodeIndex + 1];
  const hasFollowingEpisode =
    followingEpisode &&
    Number.isInteger(followingEpisode.episode) &&
    typeof followingEpisode.title === "string" &&
    followingEpisode.title.trim();

  if (currentEpisodeIndex === -1 || !hasFollowingEpisode) {
    episodeEndTitle.textContent = "You're all caught up";
    episodeEndDetail.textContent =
      "This is the latest episode currently in the archive.";
    return;
  }

  nextEpisodeNumber = followingEpisode.episode;
  // Both the eyebrow and the heading are dropped here, not just the
  // heading: "You finished {title}" plus the continue card immediately
  // below already say everything "End of episode" would have — keeping it
  // too is exactly the redundant app-chatter the reader is meant to avoid.
  // It stays for the two branches above, where it's the only thing marking
  // that the episode has actually ended.
  episodeEndEyebrow.hidden = true;
  episodeEndTitle.remove();
  episodeEndDetail.textContent = `You finished ${metadata.title}`;
  nextEpisodeTitle.textContent = followingEpisode.title;
  continueLink.href = nextEpisodeUrl();
  continueLink.hidden = false;
  if (nextEpisodeLink) {
    nextEpisodeLink.href = nextEpisodeUrl();
    nextEpisodeLink.hidden = false;
  }
  nextEpisodeIndicator.hidden = false;
}

async function fetchMapFile(mapPath) {
  let response;
  try {
    response = await fetch(mapPath);
  } catch (error) {
    const requestError = new ArchiveRequestError("Archive request failed");
    requestError.cause = error;
    throw requestError;
  }
  if (!response.ok) {
    throw new ArchiveRequestError(
      `Archive request failed with status ${response.status}`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    const formatError = new EpisodeFormatError("Archive map is not valid JSON");
    formatError.cause = error;
    throw formatError;
  }
}

function resolveLatestEpisodeNumber(manifest) {
  // archive.py writes totalEpisodes as the authoritative episode count/number
  // in map/manifest.json — trust it directly instead of re-deriving it.
  if (
    !manifest ||
    !Number.isInteger(manifest.totalEpisodes) ||
    manifest.totalEpisodes <= 0
  ) {
    return null;
  }
  return manifest.totalEpisodes;
}

function attachViewerEvents() {
  window.addEventListener("resize", handleResize, { passive: true });
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
}

async function initializeViewer() {
  // Deliberately no setViewerState() call here: the loading card's default
  // (non-error) appearance is silent by design — see styles.css — so there
  // is nothing to say yet. This covers both the plain-episode case and the
  // ep=latest resolution step ahead of it; a person opening the reader
  // doesn't need to be told which step it's on, only whether it succeeded.
  let manifest = null;
  if (isLatestRequested) {
    try {
      manifest = await fetchMapFile("map/manifest.json");
      const latestEpisode = resolveLatestEpisodeNumber(manifest);
      if (latestEpisode === null) {
        throw new LatestEpisodeUnavailableError(
          "Archive manifest has no episodes listed",
        );
      }
      episodeNumber = latestEpisode;
    } catch (error) {
      const latestError = new LatestEpisodeUnavailableError(
        "Could not resolve the latest episode",
      );
      latestError.cause = error;
      console.error(latestError);
      showViewerError(latestError);
      return;
    }
  }

  const manifestRequest = manifest
    ? Promise.resolve(manifest)
    : fetchMapFile("map/manifest.json").catch((error) => {
        console.warn("Episode navigation is unavailable:", error);
        return null;
      });

  try {
    const metadata = await fetchMapFile(`map/${episodeNumber}.json`);
    validateEpisodeMetadata(metadata);
    document.title = metadata.title;

    const images = renderPanels(metadata);
    const firstPanel = images[0] ?? null;
    reader.hidden = false;
    updateScale();
    buildAmbientGlow();
    attachViewerEvents();

    if (firstPanel) {
      await Promise.race([
        firstPanel.decode().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 2500)),
      ]);
    }
    dismissViewerState();
    // Only starts reaching ahead of the reader once the first panel is
    // actually ready to show — starting any earlier would let panels 2+
    // compete on the network with the one panel that genuinely can't wait.
    setupPreloading(images);

    const resolvedManifest = await manifestRequest;
    configureEpisodeEnd(resolvedManifest, metadata);
    // The episode-end section just went from hidden to its real, final
    // height — rebuilding now is what lets the last panel's glow (see
    // buildAmbientGlow) stretch all the way to the page's true bottom
    // instead of wherever the document ended while episode-end was hidden.
    buildAmbientGlow();
  } catch (error) {
    console.error(error);
    showViewerError(error);
  }
}

viewerStateRetry.addEventListener("click", () => location.reload());
initializeViewer();
