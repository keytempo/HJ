// Code shared by the reader (scripts.js) and the archive page (directory.js).
// It loads first on both pages, so everything declared here is a global for
// the page scripts that follow.
//
// Archive layout, relative to BASE_URL:
//   archive/episodes.json          manifest: { totalEpisodes, episodes }
//   archive/maps/<n>.json          one episode's title and panel list
//   archive/episodes/<n>/NNN.webp  that episode's panel images
// Each manifest entry is { episode, title, panelCount }. `episode` is the
// archive's own sequence number, in ascending reading order.

const BASE_URL = "https://raw.githubusercontent.com/keytempo/handjumper/main/";
const MANIFEST_PATH = "archive/episodes.json";

// options: { status, cause }: the HTTP status, when there was a response, and
// the underlying error.
class ArchiveRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ArchiveRequestError";
    this.status = options.status ?? null;
  }
}

class EpisodeFormatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EpisodeFormatError";
  }
}

async function fetchArchiveJson(path) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`);
  } catch (cause) {
    throw new ArchiveRequestError("Archive request failed", { cause });
  }
  if (!response.ok) {
    throw new ArchiveRequestError(
      `Archive request failed with status ${response.status}`,
      { status: response.status },
    );
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new EpisodeFormatError("Archive file is not valid JSON", { cause });
  }
}

function episodeMapPath(episode) {
  return `archive/maps/${episode}.json`;
}

// Panels are numbered from 001 in reading order.
function panelFilename(panelIndex) {
  return `${String(panelIndex + 1).padStart(3, "0")}.webp`;
}

function panelUrl(episode, filename) {
  return `${BASE_URL}archive/episodes/${episode}/${filename}`;
}

// Whether a manifest entry can be linked to: a positive integer episode number
// and a non-empty title.
function isListedEpisode(entry) {
  return (
    Number.isInteger(entry?.episode) &&
    entry.episode > 0 &&
    typeof entry.title === "string" &&
    entry.title.trim() !== ""
  );
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function ghostButton(label, onClick) {
  const button = el("button", "btn btn--ghost", label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}
