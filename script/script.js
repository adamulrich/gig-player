const audio = document.getElementById("audio-player");
const trackList = document.getElementById("track-list");
const playlistSelect = document.getElementById("playlist-select");
const filePicker = document.getElementById("audio-files");
const playButton = document.getElementById("play-button");
const playIcon = document.getElementById("play-icon");
const seekBar = document.getElementById("seek-bar");
const nowPlaying = document.getElementById("now-playing");
const playbackStatus = document.getElementById("playback-status");
const elapsedTime = document.getElementById("elapsed-time");
const durationTime = document.getElementById("duration-time");
const wakeStatus = document.getElementById("wake-status");
const continuousPlay = document.getElementById("continuous-play");

const DB_NAME = "gig-player-library";
const DB_VERSION = 1;
let db;
let playlists = [];
let tracks = new Map();
let activePlaylistId = null;
let selectedTrackId = null;
let activeObjectUrl = null;
let wakeLock = null;
let isUpNext = false;
let activeDrag = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("playlists")) database.createObjectStore("playlists", { keyPath: "id" });
      if (!database.objectStoreNames.contains("tracks")) database.createObjectStore("tracks", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function activePlaylist() {
  return playlists.find((playlist) => playlist.id === activePlaylistId);
}

function activeTracks() {
  return (activePlaylist()?.trackIds || []).map((id) => tracks.get(id)).filter(Boolean);
}

function displayTitle(track, playlist = activePlaylist()) {
  return playlist?.trackTitles?.[track.id] || track.title || track.name.replace(/\.[^.]+$/, "");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

function setStatus(message) {
  playbackStatus.textContent = message;
}

function updateControls() {
  const hasSelection = Boolean(selectedTrackId && tracks.has(selectedTrackId));
  playButton.disabled = !hasSelection;
  document.getElementById("stop-button").disabled = !hasSelection;
  document.getElementById("previous-button").disabled = !activeTracks().length;
  document.getElementById("next-button").disabled = !activeTracks().length;
  playIcon.textContent = audio.paused ? "▶" : "Ⅱ";
  playButton.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  playButton.title = audio.paused ? "Play" : "Pause";
  seekBar.disabled = !hasSelection || !Number.isFinite(audio.duration);
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const track = tracks.get(selectedTrackId);
  if (!track) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    return;
  }
  if ("MediaMetadata" in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: displayTitle(track), artist: "Gig Player", album: activePlaylist()?.name || "Setlist" });
  }
  navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate || 1 }); } catch (_) {}
  }
}

function updatePlayerDisplay() {
  const track = tracks.get(selectedTrackId);
  nowPlaying.textContent = track ? displayTitle(track) : "Choose a track to get started";
  elapsedTime.textContent = formatTime(audio.currentTime);
  durationTime.textContent = formatTime(audio.duration);
  seekBar.value = Number.isFinite(audio.duration) && audio.duration > 0 ? String(Math.round((audio.currentTime / audio.duration) * 1000)) : "0";
  updateControls();
  updateMediaSession();
}

function renderPlaylists() {
  playlistSelect.replaceChildren();
  playlists.forEach((playlist) => {
    const option = document.createElement("option");
    option.value = playlist.id;
    option.textContent = playlist.name;
    playlistSelect.append(option);
  });
  playlistSelect.value = activePlaylistId || "";
  const hasPlaylist = playlists.length > 0;
  document.getElementById("rename-playlist-button").disabled = !hasPlaylist;
  document.getElementById("delete-playlist-button").disabled = !hasPlaylist;
}

function renderTracks() {
  const list = activeTracks();
  trackList.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<div class="empty-icon" aria-hidden="true">♫</div><strong>Your setlist is waiting.</strong><span>Add audio files from your device to build this playlist.</span>';
    trackList.append(empty);
    return;
  }

  list.forEach((track, index) => {
    const row = document.createElement("article");
    const isCurrent = track.id === selectedTrackId;
    row.className = `track-row${isCurrent ? " is-current" : ""}${isCurrent && !audio.paused ? " is-playing" : ""}`;
    row.dataset.trackId = track.id;

    const number = document.createElement("span");
    number.className = "track-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = `Drag to reorder ${displayTitle(track)}`;
    handle.setAttribute("aria-label", `Drag to reorder ${displayTitle(track)}`);
    handle.addEventListener("pointerdown", beginDrag);
    const content = document.createElement("button");
    content.type = "button";
    content.className = "track-main";
    content.setAttribute("aria-label", `${isCurrent && !audio.paused ? "Pause" : "Play"} ${displayTitle(track)}`);
    const title = document.createElement("span");
    title.className = "track-title";
    title.textContent = displayTitle(track);
    const subtitle = document.createElement("span");
    subtitle.className = "track-subtitle";
    subtitle.textContent = isCurrent ? (!audio.paused ? "NOW PLAYING" : isUpNext ? "UP NEXT · TAP TO PLAY" : "SELECTED") : track.name;
    content.append(title, subtitle);
    content.addEventListener("click", () => selectTrack(track.id, true));

    const tools = document.createElement("div");
    tools.className = "row-tools";
    tools.append(
      makeRowButton("↑", "Move up", () => moveTrack(index, -1), index === 0),
      makeRowButton("↓", "Move down", () => moveTrack(index, 1), index === list.length - 1),
      makeRowButton("✎", `Rename ${displayTitle(track)} in this playlist`, () => renameTrack(track.id)),
      makeRowButton("×", `Remove ${displayTitle(track)}`, () => removeTrack(track.id), false, true)
    );
    row.append(handle, number, content, tools);
    trackList.append(row);
  });
}

function makeRowButton(label, title, onClick, disabled = false, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `row-tool${danger ? " remove-tool" : ""}`;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function beginDrag(event) {
  if (event.button !== 0 || activeDrag) return;
  const row = event.currentTarget.closest(".track-row");
  if (!row) return;
  event.preventDefault();
  activeDrag = { pointerId: event.pointerId, row, changed: false, clientX: event.clientX, clientY: event.clientY };
  row.classList.add("is-dragging");
  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointerup", finishDrag, { once: true });
  document.addEventListener("pointercancel", finishDrag, { once: true });
  requestAnimationFrame(autoScrollDrag);
}

function moveDrag(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  activeDrag.clientX = event.clientX;
  activeDrag.clientY = event.clientY;
  updateDragPosition(event.clientX, event.clientY);
}

function updateDragPosition(clientX, clientY) {
  if (!activeDrag) return;
  const target = document.elementFromPoint(clientX, clientY)?.closest(".track-row");
  if (!target || target === activeDrag.row || target.parentElement !== trackList) return;
  const rect = target.getBoundingClientRect();
  if (clientY < rect.top + rect.height / 2) {
    if (target.previousElementSibling !== activeDrag.row) {
      target.before(activeDrag.row);
      activeDrag.changed = true;
    }
  } else if (target.nextElementSibling !== activeDrag.row) {
    target.after(activeDrag.row);
    activeDrag.changed = true;
  }
}

function autoScrollDrag() {
  if (!activeDrag) return;
  const edge = 72;
  const y = activeDrag.clientY;
  if (y < edge) {
    window.scrollBy(0, -Math.max(4, Math.round((edge - y) / 3)));
    updateDragPosition(activeDrag.clientX, y);
  } else if (y > window.innerHeight - edge) {
    window.scrollBy(0, Math.max(4, Math.round((y - (window.innerHeight - edge)) / 3)));
    updateDragPosition(activeDrag.clientX, y);
  }
  requestAnimationFrame(autoScrollDrag);
}

async function finishDrag(event) {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
  const draggedRow = activeDrag.row;
  const changed = activeDrag.changed;
  activeDrag = null;
  draggedRow.classList.remove("is-dragging");
  document.removeEventListener("pointermove", moveDrag);
  document.removeEventListener("pointerup", finishDrag);
  document.removeEventListener("pointercancel", finishDrag);
  if (!changed) return;
  const playlist = activePlaylist();
  if (!playlist) return;
  playlist.trackIds = Array.from(trackList.querySelectorAll(".track-row"), (row) => row.dataset.trackId);
  try {
    await savePlaylist(playlist);
    renderTracks();
  } catch (_) {
    setStatus("Could not save the new order.");
    renderTracks();
  }
}

async function savePlaylist(playlist) {
  await storeRequest("playlists", "readwrite", (store) => store.put(playlist));
}

async function selectTrack(id, startPlayback) {
  const track = tracks.get(id);
  if (!track) return;
  if (selectedTrackId === id && startPlayback) {
    isUpNext = false;
    if (audio.paused && audio.src) await audio.play().catch(() => setStatus("Could not play this audio file."));
    else if (!audio.paused) audio.pause();
    updatePlayerDisplay();
    return;
  }
  audio.pause();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = URL.createObjectURL(track.blob);
  selectedTrackId = id;
  isUpNext = false;
  audio.src = activeObjectUrl;
  audio.currentTime = 0;
  setStatus(startPlayback ? "Loading track…" : "Ready when you are · Tap play to start");
  updatePlayerDisplay();
  renderTracks();
  if (startPlayback) {
    requestWakeLock();
    await audio.play().catch(() => setStatus("Could not play this audio file."));
  }
  updatePlayerDisplay();
}

function moveTrack(index, direction) {
  const playlist = activePlaylist();
  if (!playlist) return;
  const target = index + direction;
  if (target < 0 || target >= playlist.trackIds.length) return;
  [playlist.trackIds[index], playlist.trackIds[target]] = [playlist.trackIds[target], playlist.trackIds[index]];
  savePlaylist(playlist).then(renderTracks).catch(() => setStatus("Could not save the new order."));
}

async function renameTrack(id) {
  const playlist = activePlaylist();
  const track = tracks.get(id);
  if (!playlist || !track) return;
  const name = prompt("Name shown in this playlist", displayTitle(track));
  if (name === null) return;
  const title = name.trim();
  if (!title) {
    setStatus("Song name cannot be empty.");
    return;
  }
  playlist.trackTitles ||= {};
  playlist.trackTitles[id] = title;
  try {
    await savePlaylist(playlist);
    renderTracks();
    updatePlayerDisplay();
    setStatus("Playlist name updated · Audio file unchanged");
  } catch (_) {
    setStatus("Could not save the playlist name.");
  }
}

async function removeTrack(id) {
  const playlist = activePlaylist();
  if (!playlist) return;
  playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== id);
  await savePlaylist(playlist);
  if (![...playlists].some((item) => item.trackIds.includes(id))) {
    tracks.delete(id);
    await storeRequest("tracks", "readwrite", (store) => store.delete(id));
  }
  if (selectedTrackId === id) stopPlayback();
  renderTracks();
}

function stopPlayback() {
  audio.pause();
  audio.currentTime = 0;
  selectedTrackId = null;
  isUpNext = false;
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
  audio.removeAttribute("src");
  audio.load();
  setStatus("Playback stopped");
  updatePlayerDisplay();
  renderTracks();
}

async function playRelative(direction) {
  const list = activeTracks();
  if (!list.length) return;
  let index = list.findIndex((track) => track.id === selectedTrackId);
  if (index < 0) index = direction > 0 ? -1 : 0;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= list.length) return;
  await selectTrack(list[nextIndex].id, true);
}

async function goBack() {
  if (selectedTrackId && audio.currentTime > 3) {
    audio.currentTime = 0;
    elapsedTime.textContent = "0:00";
    seekBar.value = "0";
    setStatus(audio.paused ? "Ready to play from the beginning" : "Playing from the beginning");
    updateMediaSession();
    return;
  }
  await playRelative(-1);
}

async function importFiles(files) {
  const accepted = Array.from(files).filter((file) => file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name));
  if (!accepted.length) return;
  const playlist = activePlaylist();
  const imported = [];
  try {
    for (const file of accepted) {
      const track = { id: makeId(), name: file.name, title: file.name.replace(/\.[^.]+$/, ""), type: file.type, blob: file };
      await storeRequest("tracks", "readwrite", (store) => store.put(track));
      tracks.set(track.id, track);
      imported.push(track.id);
    }
    playlist.trackIds.push(...imported);
    await savePlaylist(playlist);
    renderTracks();
    setStatus(`${imported.length} ${imported.length === 1 ? "track" : "tracks"} added to ${playlist.name}`);
  } catch (error) {
    setStatus("Could not save these files. Check available device storage and try again.");
  }
  filePicker.value = "";
}

async function changePlaylist(id) {
  if (id === activePlaylistId || !playlists.some((playlist) => playlist.id === id)) return;
  stopPlayback();
  activePlaylistId = id;
  localStorage.setItem("gig-player-active-playlist", id);
  renderPlaylists();
  renderTracks();
  setStatus(`Playlist: ${activePlaylist()?.name || "Setlist"}`);
}

async function createPlaylist() {
  const name = prompt("Name your playlist");
  if (!name?.trim()) return;
  const playlist = { id: makeId(), name: name.trim(), trackIds: [] };
  playlists.push(playlist);
  await savePlaylist(playlist);
  await changePlaylist(playlist.id);
}

async function renamePlaylist() {
  const playlist = activePlaylist();
  if (!playlist) return;
  const name = prompt("Rename playlist", playlist.name);
  if (!name?.trim()) return;
  playlist.name = name.trim();
  await savePlaylist(playlist);
  renderPlaylists();
  updateMediaSession();
}

async function deletePlaylist() {
  if (playlists.length <= 1) {
    setStatus("Keep at least one playlist. Rename this one to reuse it.");
    return;
  }
  const playlist = activePlaylist();
  if (!playlist || !confirm(`Delete “${playlist.name}”? Tracks used in another playlist will stay saved.`)) return;
  stopPlayback();
  playlists = playlists.filter((item) => item.id !== playlist.id);
  await storeRequest("playlists", "readwrite", (store) => store.delete(playlist.id));
  const referenced = new Set(playlists.flatMap((item) => item.trackIds));
  for (const id of tracks.keys()) {
    if (!referenced.has(id)) {
      tracks.delete(id);
      await storeRequest("tracks", "readwrite", (store) => store.delete(id));
    }
  }
  activePlaylistId = playlists[0].id;
  localStorage.setItem("gig-player-active-playlist", activePlaylistId);
  renderPlaylists();
  renderTracks();
  setStatus(`Playlist: ${activePlaylist().name}`);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    wakeStatus.textContent = "NO WAKE LOCK";
    document.querySelector(".status-dot").classList.add("is-off");
    document.querySelector(".local-badge").title = "This browser does not support keeping the screen awake.";
    return;
  }
  if (document.visibilityState !== "visible" || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeStatus.textContent = "SCREEN AWAKE";
    document.querySelector(".status-dot").classList.remove("is-off");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      wakeStatus.textContent = "SCREEN LOCK OFF";
      document.querySelector(".status-dot").classList.add("is-off");
    }, { once: true });
  } catch (_) {
    wakeStatus.textContent = "SCREEN LOCK OFF";
    document.querySelector(".status-dot").classList.add("is-off");
    document.querySelector(".local-badge").title = "The device did not grant a screen wake lock.";
  }
}

function registerMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const actions = {
    play: () => { if (selectedTrackId) audio.play(); else if (activeTracks()[0]) selectTrack(activeTracks()[0].id, true); },
    pause: () => audio.pause(),
    stop: stopPlayback,
    previoustrack: goBack,
    nexttrack: () => playRelative(1),
    seekto: (event) => { if (Number.isFinite(event.seekTime)) audio.currentTime = event.seekTime; }
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  }
}

audio.addEventListener("timeupdate", updatePlayerDisplay);
audio.addEventListener("durationchange", updatePlayerDisplay);
audio.addEventListener("play", () => { setStatus("Playing"); updatePlayerDisplay(); renderTracks(); requestWakeLock(); });
audio.addEventListener("pause", () => { if (selectedTrackId && audio.currentTime < audio.duration) setStatus("Paused"); updatePlayerDisplay(); renderTracks(); });
audio.addEventListener("ended", async () => {
  const list = activeTracks();
  const index = list.findIndex((track) => track.id === selectedTrackId);
  if (index >= 0 && index < list.length - 1) {
    await selectTrack(list[index + 1].id, continuousPlay.checked);
    if (continuousPlay.checked) {
      if (!audio.paused) setStatus("Playing next track");
    } else {
      isUpNext = true;
      renderTracks();
      setStatus("Song complete · Next track is ready when you are");
    }
  } else {
    setStatus("Set complete · Add or select another track");
    updatePlayerDisplay();
    renderTracks();
  }
});
seekBar.addEventListener("input", () => {
  if (Number.isFinite(audio.duration)) {
    audio.currentTime = (Number(seekBar.value) / 1000) * audio.duration;
    elapsedTime.textContent = formatTime(audio.currentTime);
  }
});
playButton.addEventListener("click", async () => {
  if (!selectedTrackId && activeTracks()[0]) await selectTrack(activeTracks()[0].id, true);
  else if (audio.paused) { await audio.play().catch(() => setStatus("Could not play this audio file.")); requestWakeLock(); }
  else audio.pause();
});
document.getElementById("stop-button").addEventListener("click", stopPlayback);
document.getElementById("previous-button").addEventListener("click", goBack);
document.getElementById("next-button").addEventListener("click", () => playRelative(1));
playlistSelect.addEventListener("change", () => changePlaylist(playlistSelect.value));
filePicker.addEventListener("change", () => importFiles(filePicker.files));
document.getElementById("new-playlist-button").addEventListener("click", createPlaylist);
document.getElementById("rename-playlist-button").addEventListener("click", renamePlaylist);
document.getElementById("delete-playlist-button").addEventListener("click", deletePlaylist);
continuousPlay.checked = localStorage.getItem("gig-player-continuous-play") === "true";
continuousPlay.addEventListener("change", () => localStorage.setItem("gig-player-continuous-play", String(continuousPlay.checked)));
window.addEventListener("beforeunload", (event) => {
  if (!selectedTrackId) return;
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestWakeLock(); });
document.addEventListener("pointerdown", requestWakeLock, { once: true });

async function initialize() {
  try {
    db = await openDatabase();
    const [savedPlaylists, savedTracks] = await Promise.all([
      storeRequest("playlists", "readonly", (store) => store.getAll()),
      storeRequest("tracks", "readonly", (store) => store.getAll())
    ]);
    playlists = savedPlaylists;
    tracks = new Map(savedTracks.map((track) => [track.id, track]));
    if (!playlists.length) {
      const starter = { id: makeId(), name: "Main Set", trackIds: [] };
      playlists.push(starter);
      await savePlaylist(starter);
    }
    const remembered = localStorage.getItem("gig-player-active-playlist");
    activePlaylistId = playlists.some((playlist) => playlist.id === remembered) ? remembered : playlists[0].id;
    localStorage.setItem("gig-player-active-playlist", activePlaylistId);
    renderPlaylists();
    updatePlayerDisplay();
    renderTracks();
    setStatus("Your music stays on this device");
  } catch (error) {
    setStatus("Local music storage is unavailable in this browser.");
    document.getElementById("storage-note").textContent = "Open this app in a browser that supports local storage to save playlists and tracks.";
  }
  registerMediaSession();
  requestWakeLock();
}

initialize();
