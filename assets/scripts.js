// Shared column width every panel is displayed at (see styles.css
// --panel-width), regardless of that panel's own native resolution —
// height:auto in CSS renormalizes each panel to this width using its own
// aspect ratio, so panels are free to have differing native widths.
const BASE_URL = "https://raw.githubusercontent.com/keytempo/handjumper/main/";
const PANEL_WIDTH = 800;
const PULL_THRESHOLD = 120;
const WHEEL_ARM_DELAY = 240;
const WHEEL_FINISH_DELAY = 180;
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
const viewerState = document.getElementById("viewer-state");
const viewerStateTitle = document.getElementById("viewer-state-title");
const viewerStateDetail = document.getElementById("viewer-state-detail");
const viewerStateRetry = document.getElementById("viewer-state-retry");
const episodeEnd = document.getElementById("episode-end");
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
const prevEpisodeIndicator = document.getElementById("prev-episode");
const prevEpisodeLabel = prevEpisodeIndicator
  ? prevEpisodeIndicator.querySelector(".prev-episode__label")
  : null;

let prevEpisodeNumber = episodeNumber > 1 ? episodeNumber - 1 : null;
let nextEpisodeNumber = null;
let pullDistance = 0;
let pullInput = null;
let pullDirection = null;
let touchY = null;
let wheelArmTimer = null;
let wheelFinishTimer = null;
let armedWheelDirection = null;
let isNavigating = false;
let resizeFrame = null;
let tapStartX = null;
let tapStartY = null;
let tapStartTime = 0;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

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

function setViewerState(title, detail, { canRetry = false } = {}) {
  viewerState.hidden = false;
  viewerState.classList.remove("is-hidden");
  viewerState.classList.toggle("is-error", canRetry);
  viewerState.setAttribute("role", canRetry ? "alert" : "status");
  viewerStateTitle.textContent = title;
  viewerStateDetail.textContent = detail;
  // Quiet by default (see the .visually-hidden classes in index.html): the
  // heading and detail sentence are only worth looking at once there's an
  // error and a retry to offer. They stay in the DOM either way, so screen
  // readers still get the "Opening episode" / "Finding the latest episode"
  // announcements via the live region even while sighted users just see
  // the thin loader bar.
  viewerStateTitle.classList.toggle("visually-hidden", !canRetry);
  viewerStateDetail.classList.toggle("visually-hidden", !canRetry);
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
  retry.className = "btn btn--ghost";
  retry.textContent = "Retry panel";
  retry.addEventListener("click", () => {
    const replacement = createPanel(panel, panelIndex);
    const host = placeholder.closest(".panel") ?? placeholder;
    host.replaceWith(replacement);
  });

  content.append(title, detail, retry);
  placeholder.append(content);
  return placeholder;
}

// Each panel is a full-bleed section: a CSS-blurred ambient layer sits
// behind the sharp comic panel. No getBoundingClientRect, no stored
// offsets, no rebuild on resize — the glow is just layout.
//
// The glow is only created once the sharp image has loaded, and reuses its
// already-loaded URL. That keeps it to a single network fetch per panel and
// means the glow can never load on a different schedule than its panel.
function attachGlow(wrapper, image) {
  const glow = document.createElement("img");
  glow.className = "panel__glow";
  glow.alt = "";
  glow.decoding = "async";
  glow.src = image.currentSrc || image.src;
  wrapper.prepend(glow);

  // Wait for decode + one frame so the blur filter is composited
  // before we reveal the glow (avoids unfiltered flash / artifacts).
  glow.decode().then(
    () => requestAnimationFrame(() => glow.classList.add("is-ready")),
    () => glow.remove(),
  );
}

function createPanel(panel, panelIndex) {
  const wrapper = document.createElement("div");
  wrapper.className = "panel";

  const image = document.createElement("img");
  image.className = "panel__image";
  image.src = `${BASE_URL}archive/episodes/${episodeNumber}/${panel.file}`;
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
    () => {
      const unavailable = createPanelUnavailable(panel, panelIndex);
      image.replaceWith(unavailable);
    },
    { once: true },
  );

  wrapper.append(image);
  return wrapper;
}

function renderPanels(metadata) {
  const panels = document.createDocumentFragment();
  let firstImage = null;

  metadata.panels.forEach((panel, panelIndex) => {
    const node = createPanel(panel, panelIndex);
    if (panelIndex === 0) {
      firstImage = node.querySelector(".panel__image");
    }
    panels.append(node);
  });

  episodeTitle.textContent = metadata.title;
  strip.setAttribute(
    "aria-label",
    `${metadata.title}, ${metadata.panelCount} visual panels`,
  );
  strip.setAttribute("role", "group");
  strip.replaceChildren(panels);
  return firstImage;
}

function isAtTop() {
  return window.scrollY <= 2;
}

function isAtBottom() {
  return (
    window.scrollY + window.innerHeight >=
    document.documentElement.scrollHeight - 2
  );
}

function setNextPullLabel(label) {
  if (nextEpisodeLabel && nextEpisodeLabel.textContent !== label) {
    nextEpisodeLabel.textContent = label;
  }
}

function setPrevPullLabel(label) {
  if (prevEpisodeLabel && prevEpisodeLabel.textContent !== label) {
    prevEpisodeLabel.textContent = label;
  }
}

function setPullDistance(distance, input, direction) {
  pullDistance = Math.max(0, Math.min(distance, PULL_THRESHOLD));
  pullInput = pullDistance > 0 ? input : null;
  pullDirection = pullDistance > 0 ? direction : null;
  const progress = pullDistance / PULL_THRESHOLD;

  const indicator =
    direction === "prev" ? prevEpisodeIndicator : nextEpisodeIndicator;
  const otherIndicator =
    direction === "prev" ? nextEpisodeIndicator : prevEpisodeIndicator;

  if (otherIndicator) {
    otherIndicator.style.setProperty("--pull-progress", 0);
    otherIndicator.classList.remove("is-ready");
  }

  if (!indicator) return;

  indicator.style.setProperty("--pull-progress", progress);
  indicator.classList.toggle("is-ready", progress === 1);

  if (direction === "prev") {
    if (progress === 1) {
      setPrevPullLabel(
        input === "touch"
          ? "Release for previous episode"
          : "Previous episode ready",
      );
    } else {
      setPrevPullLabel(
        input === "wheel"
          ? "Keep scrolling for previous episode"
          : "Pull for previous episode",
      );
    }
  } else if (direction === "next") {
    if (progress === 1) {
      setNextPullLabel(
        input === "touch" ? "Release for next episode" : "Next episode ready",
      );
    } else {
      setNextPullLabel(
        input === "wheel"
          ? "Keep scrolling for next episode"
          : "Pull for next episode",
      );
    }
  }
}

function resetPull() {
  armedWheelDirection = null;
  pullDistance = 0;
  pullInput = null;
  pullDirection = null;
  if (nextEpisodeIndicator) {
    nextEpisodeIndicator.style.setProperty("--pull-progress", 0);
    nextEpisodeIndicator.classList.remove("is-ready");
  }
  if (prevEpisodeIndicator) {
    prevEpisodeIndicator.style.setProperty("--pull-progress", 0);
    prevEpisodeIndicator.classList.remove("is-ready");
  }
}

function episodeUrl(number) {
  const url = new URL(location.href);
  url.searchParams.set("ep", String(number));
  return url;
}

function nextEpisodeUrl() {
  return episodeUrl(nextEpisodeNumber);
}

function prevEpisodeUrl() {
  return episodeUrl(prevEpisodeNumber);
}

function navigateToNextEpisode() {
  if (isNavigating || nextEpisodeNumber === null) return;

  isNavigating = true;
  if (nextEpisodeIndicator) {
    nextEpisodeIndicator.classList.add("is-loading");
    setNextPullLabel("Loading next episode…");
  }
  window.setTimeout(() => location.assign(nextEpisodeUrl()), 120);
}

function navigateToPrevEpisode() {
  if (isNavigating || prevEpisodeNumber === null) return;

  isNavigating = true;
  if (prevEpisodeIndicator) {
    prevEpisodeIndicator.classList.add("is-loading");
    setPrevPullLabel("Loading previous episode…");
  }
  window.setTimeout(() => location.assign(prevEpisodeUrl()), 120);
}

function finishPull() {
  if (pullDistance >= PULL_THRESHOLD) {
    if (pullDirection === "prev") navigateToPrevEpisode();
    else if (pullDirection === "next") navigateToNextEpisode();
    else resetPull();
  } else {
    resetPull();
  }
}

function normalizeWheelDelta(event) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function handleWheel(event) {
  if (isNavigating) return;

  if (event.deltaY > 0) {
    if (armedWheelDirection === "prev" || pullDirection === "prev") {
      window.clearTimeout(wheelArmTimer);
      resetPull();
    }

    if (nextEpisodeNumber === null || !isAtBottom()) {
      if (armedWheelDirection === "next" || pullDirection === "next") {
        window.clearTimeout(wheelArmTimer);
        resetPull();
      }
      return;
    }

    if (armedWheelDirection !== "next") {
      window.clearTimeout(wheelArmTimer);
      wheelArmTimer = window.setTimeout(() => {
        if (isAtBottom()) {
          armedWheelDirection = "next";
        }
      }, WHEEL_ARM_DELAY);
      return;
    }

    event.preventDefault();
    setPullDistance(
      pullDistance + normalizeWheelDelta(event) * 0.35,
      "wheel",
      "next",
    );
    window.clearTimeout(wheelFinishTimer);
    wheelFinishTimer = window.setTimeout(finishPull, WHEEL_FINISH_DELAY);
    return;
  }

  if (event.deltaY < 0) {
    if (armedWheelDirection === "next" || pullDirection === "next") {
      window.clearTimeout(wheelArmTimer);
      resetPull();
    }

    if (prevEpisodeNumber === null || !isAtTop()) {
      if (armedWheelDirection === "prev" || pullDirection === "prev") {
        window.clearTimeout(wheelArmTimer);
        resetPull();
      }
      return;
    }

    if (armedWheelDirection !== "prev") {
      window.clearTimeout(wheelArmTimer);
      wheelArmTimer = window.setTimeout(() => {
        if (isAtTop()) {
          armedWheelDirection = "prev";
        }
      }, WHEEL_ARM_DELAY);
      return;
    }

    event.preventDefault();
    setPullDistance(
      pullDistance + Math.abs(normalizeWheelDelta(event)) * 0.35,
      "wheel",
      "prev",
    );
    window.clearTimeout(wheelFinishTimer);
    wheelFinishTimer = window.setTimeout(finishPull, WHEEL_FINISH_DELAY);
    return;
  }
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
    isNavigating
  ) {
    return;
  }

  const currentY = event.touches[0].clientY;
  const delta = touchY - currentY;
  touchY = currentY;

  if (pullDirection === "next") {
    event.preventDefault();
    const newDistance = pullDistance + delta * (delta > 0 ? 0.55 : 1);
    if (newDistance <= 0) resetPull();
    else setPullDistance(newDistance, "touch", "next");
    return;
  }

  if (pullDirection === "prev") {
    event.preventDefault();
    const pullDelta = -delta;
    const newDistance = pullDistance + pullDelta * (pullDelta > 0 ? 0.55 : 1);
    if (newDistance <= 0) resetPull();
    else setPullDistance(newDistance, "touch", "prev");
    return;
  }

  if (isAtBottom() && delta > 0 && nextEpisodeNumber !== null) {
    event.preventDefault();
    setPullDistance(delta * 0.55, "touch", "next");
    return;
  }

  if (isAtTop() && delta < 0 && prevEpisodeNumber !== null) {
    event.preventDefault();
    setPullDistance(-delta * 0.55, "touch", "prev");
    return;
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
  if (armedWheelDirection === "next" && !isAtBottom()) {
    window.clearTimeout(wheelArmTimer);
    resetPull();
  } else if (armedWheelDirection === "prev" && !isAtTop()) {
    window.clearTimeout(wheelArmTimer);
    resetPull();
  }
}

function handleResize() {
  window.cancelAnimationFrame(resizeFrame);
  resizeFrame = window.requestAnimationFrame(() => {
    updateScale();
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
  } else if (event.key === "ArrowLeft" && prevEpisodeNumber !== null) {
    event.preventDefault();
    navigateToPrevEpisode();
  }
}

function configureEpisodeEnd(manifest, metadata) {
  episodeEnd.hidden = false;
  continueLink.hidden = true;
  if (nextEpisodeLink) nextEpisodeLink.hidden = true;

  if (!manifest || !Array.isArray(manifest.episodes)) {
    episodeEndTitle.textContent = "Episode complete";
    episodeEndDetail.textContent = "You've reached the end of this episode.";
    if (prevEpisodeLink) {
      prevEpisodeLink.hidden = prevEpisodeNumber === null;
      if (!prevEpisodeLink.hidden) {
        prevEpisodeLink.href = prevEpisodeUrl();
      }
    }
    if (prevEpisodeIndicator) {
      prevEpisodeIndicator.hidden = prevEpisodeNumber === null;
    }
    return;
  }

  const currentEpisodeIndex = manifest.episodes.findIndex(
    (episode) => episode.episode === episodeNumber,
  );
  const precedingEpisode =
    currentEpisodeIndex > 0 ? manifest.episodes[currentEpisodeIndex - 1] : null;
  const hasPrecedingEpisode =
    precedingEpisode &&
    Number.isInteger(precedingEpisode.episode) &&
    typeof precedingEpisode.title === "string" &&
    precedingEpisode.title.trim();

  if (hasPrecedingEpisode) {
    prevEpisodeNumber = precedingEpisode.episode;
  } else if (currentEpisodeIndex === 0) {
    prevEpisodeNumber = null;
  }

  if (prevEpisodeLink) {
    prevEpisodeLink.hidden = prevEpisodeNumber === null;
    if (!prevEpisodeLink.hidden) {
      prevEpisodeLink.href = prevEpisodeUrl();
    }
  }

  if (prevEpisodeIndicator) {
    prevEpisodeIndicator.hidden = prevEpisodeNumber === null;
  }

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
    response = await fetch(`${BASE_URL}${mapPath}`);
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
  // in archive/episodes.json — trust it directly instead of re-deriving it.
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
  setViewerState(
    isLatestRequested ? "Finding the latest episode" : "Opening episode",
    isLatestRequested
      ? "Checking the archive for the newest update."
      : "Preparing the panels for you.",
  );

  let manifest = null;
  if (isLatestRequested) {
    try {
      manifest = await fetchMapFile("archive/episodes.json");
      const latestEpisode = resolveLatestEpisodeNumber(manifest);
      if (latestEpisode === null) {
        throw new LatestEpisodeUnavailableError(
          "Archive manifest has no episodes listed",
        );
      }
      episodeNumber = latestEpisode;
      prevEpisodeNumber = episodeNumber > 1 ? episodeNumber - 1 : null;
    } catch (error) {
      const latestError = new LatestEpisodeUnavailableError(
        "Could not resolve the latest episode",
      );
      latestError.cause = error;
      console.error(latestError);
      showViewerError(latestError);
      return;
    }
    setViewerState("Opening episode", "Preparing the panels for you.");
  }

  const manifestRequest = manifest
    ? Promise.resolve(manifest)
    : fetchMapFile("archive/episodes.json").catch((error) => {
        console.warn("Episode navigation is unavailable:", error);
        return null;
      });

  try {
    const metadata = await fetchMapFile(`archive/maps/${episodeNumber}.json`);
    validateEpisodeMetadata(metadata);
    document.title = metadata.title;

    const firstPanel = renderPanels(metadata);
    reader.hidden = false;
    updateScale();
    attachViewerEvents();
    if (prevEpisodeIndicator) {
      prevEpisodeIndicator.hidden = prevEpisodeNumber === null;
    }

    if (firstPanel) {
      await Promise.race([
        firstPanel.decode().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 2500)),
      ]);
    }
    dismissViewerState();

    const resolvedManifest = await manifestRequest;
    configureEpisodeEnd(resolvedManifest, metadata);
  } catch (error) {
    console.error(error);
    showViewerError(error);
  }
}

viewerStateRetry.addEventListener("click", () => location.reload());
initializeViewer();
