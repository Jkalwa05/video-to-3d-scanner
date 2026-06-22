const refs = {
  capCamera: document.querySelector("#capCamera"),
  capMotion: document.querySelector("#capMotion"),
  capWebXR: document.querySelector("#capWebXR"),
  capDepth: document.querySelector("#capDepth"),
  poseMode: document.querySelector("#poseMode"),
  secureHint: document.querySelector("#secureHint"),
  cameraButton: document.querySelector("#cameraButton"),
  motionButton: document.querySelector("#motionButton"),
  scanButton: document.querySelector("#scanButton"),
  stopScanButton: document.querySelector("#stopScanButton"),
  sendScanButton: document.querySelector("#sendScanButton"),
  refreshInboxButton: document.querySelector("#refreshInboxButton"),
  analyzeStoredButton: document.querySelector("#analyzeStoredButton"),
  scanType: document.querySelector("#scanType"),
  deviceLabel: document.querySelector("#deviceLabel"),
  frameBudget: document.querySelector("#frameBudget"),
  frameBudgetValue: document.querySelector("#frameBudgetValue"),
  captureInterval: document.querySelector("#captureInterval"),
  captureIntervalValue: document.querySelector("#captureIntervalValue"),
  blurThreshold: document.querySelector("#blurThreshold"),
  blurThresholdValue: document.querySelector("#blurThresholdValue"),
  duplicateThreshold: document.querySelector("#duplicateThreshold"),
  duplicateThresholdValue: document.querySelector("#duplicateThresholdValue"),
  scanPrompt: document.querySelector("#scanPrompt"),
  liveVideo: document.querySelector("#liveVideo"),
  liveOverlay: document.querySelector("#liveOverlay"),
  scanStatus: document.querySelector("#scanStatus"),
  transferStatus: document.querySelector("#transferStatus"),
  selectedScanLabel: document.querySelector("#selectedScanLabel"),
  inboxStatus: document.querySelector("#inboxStatus"),
  yawValue: document.querySelector("#yawValue"),
  pitchValue: document.querySelector("#pitchValue"),
  rollValue: document.querySelector("#rollValue"),
  accValue: document.querySelector("#accValue"),
  depthValue: document.querySelector("#depthValue"),
  coverageValue: document.querySelector("#coverageValue"),
  preprocessSummary: document.querySelector("#preprocessSummary"),
  statCandidates: document.querySelector("#statCandidates"),
  statAccepted: document.querySelector("#statAccepted"),
  statBlur: document.querySelector("#statBlur"),
  statDuplicate: document.querySelector("#statDuplicate"),
  frameStrip: document.querySelector("#frameStrip"),
  inboxList: document.querySelector("#inboxList"),
  sceneCanvas: document.querySelector("#sceneCanvas"),
  sceneNote: document.querySelector("#sceneNote"),
  objectList: document.querySelector("#objectList"),
  summaryList: document.querySelector("#summaryList"),
  problemList: document.querySelector("#problemList"),
  partsToolsList: document.querySelector("#partsToolsList"),
  nextStepsList: document.querySelector("#nextStepsList"),
  rawResult: document.querySelector("#rawResult"),
};

const state = {
  capabilities: {
    secureContext: window.isSecureContext,
    camera: false,
    motion: false,
    webxr: false,
    immersiveAr: false,
    depth: false,
  },
  stream: null,
  motionActive: false,
  scanning: false,
  captureTimer: null,
  captureBusy: false,
  scanStartedAt: 0,
  frames: [],
  frameCards: new Map(),
  lastOrientation: null,
  lastMotion: null,
  stats: {
    candidates: 0,
    accepted: 0,
    rejectedBlur: 0,
    rejectedDuplicate: 0,
  },
  analysis: null,
  inbox: [],
  selectedScanId: null,
  currentUploadedScanId: null,
};

const offscreenCanvas = document.createElement("canvas");
const offscreenContext = offscreenCanvas.getContext("2d", { willReadFrequently: true });

function inferDeviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone Scan Client";
  if (/iPad/i.test(ua)) return "iPad Scan Client";
  if (/Android/i.test(ua)) return "Android Scan Client";
  if (/Macintosh|Mac OS X/i.test(ua)) return "MacBook Scan Client";
  if (/Windows/i.test(ua)) return "Windows Scan Client";
  return "Browser Scan Client";
}

function setStatus(message) {
  refs.scanStatus.textContent = message;
}

function setTransferStatus(message) {
  refs.transferStatus.textContent = message;
}

function setInboxStatus(message) {
  refs.inboxStatus.textContent = message;
}

function setSelectedScanLabel(message) {
  refs.selectedScanLabel.textContent = message;
}

function setRawResult(value) {
  refs.rawResult.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function degrees(value) {
  return value == null || Number.isNaN(value) ? "--" : `${Math.round(value)}°`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateSliderLabels() {
  refs.frameBudgetValue.textContent = refs.frameBudget.value;
  refs.captureIntervalValue.textContent = `${refs.captureInterval.value} ms`;
  refs.blurThresholdValue.textContent = refs.blurThreshold.value;
  refs.duplicateThresholdValue.textContent = Number(refs.duplicateThreshold.value).toFixed(2);
}

function renderCapabilityStatus() {
  refs.capCamera.textContent = state.capabilities.camera ? "Verfuegbar" : "Nicht verfuegbar";
  refs.capMotion.textContent = state.motionActive
    ? "Freigegeben"
    : state.capabilities.motion
      ? "Verfuegbar"
      : "Nicht verfuegbar";
  refs.capWebXR.textContent = state.capabilities.immersiveAr ? "AR moeglich" : "Fallback";
  refs.capDepth.textContent = state.capabilities.depth ? "Depth moeglich" : "Browser-Fallback";
  refs.poseMode.textContent = state.capabilities.depth
    ? "XR / Depth"
    : state.motionActive
      ? "Gyro-heuristisch"
      : "Capture-Heuristik";

  refs.secureHint.textContent = state.capabilities.secureContext
    ? "Sichere Umgebung erkannt. Kamera und Sensoren koennen direkt angefragt werden."
    : "Nicht in sicherem Kontext. Auf Smartphones braucht ihr HTTPS oder localhost, sonst blockieren Kamera und Sensoren.";
}

async function probeCapabilities() {
  state.capabilities.camera = Boolean(navigator.mediaDevices?.getUserMedia);
  state.capabilities.motion = "DeviceOrientationEvent" in window || "DeviceMotionEvent" in window;
  state.capabilities.webxr = "xr" in navigator;

  if (navigator.xr?.isSessionSupported) {
    try {
      state.capabilities.immersiveAr = await navigator.xr.isSessionSupported("immersive-ar");
      state.capabilities.depth = state.capabilities.immersiveAr;
    } catch {
      state.capabilities.immersiveAr = false;
      state.capabilities.depth = false;
    }
  }

  refs.depthValue.textContent = state.capabilities.depth ? "Optional via WebXR" : "Fallback aktiv";
  renderCapabilityStatus();
}

function coverageFromFrames() {
  const uniqueYawBuckets = new Set(
    state.frames
      .map((frame) => frame.pose?.rotation?.yaw)
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.round(value / 30) * 30),
  );

  return state.frames.length
    ? Math.min(100, Math.round((uniqueYawBuckets.size / 12) * 100))
    : 0;
}

function updateStats() {
  refs.statCandidates.textContent = state.stats.candidates;
  refs.statAccepted.textContent = state.stats.accepted;
  refs.statBlur.textContent = state.stats.rejectedBlur;
  refs.statDuplicate.textContent = state.stats.rejectedDuplicate;

  const coverage = coverageFromFrames();
  refs.coverageValue.textContent = `${coverage}%`;
  refs.preprocessSummary.textContent = [
    `Ausgewaehlte Frames: ${state.frames.length}`,
    `Kandidaten: ${state.stats.candidates}`,
    `Verworfen wegen Unschaerfe: ${state.stats.rejectedBlur}`,
    `Verworfen wegen Duplicate: ${state.stats.rejectedDuplicate}`,
    `Pose-Modus: ${refs.poseMode.textContent}`,
    `Depth / LiDAR: ${refs.depthValue.textContent}`,
    `Inbox-Scan: ${state.selectedScanId || "--"}`,
  ].join("\n");
}

async function ensureCamera() {
  if (state.stream) {
    return state.stream;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Die Kamera-API ist in diesem Browser nicht verfuegbar.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });

  state.stream = stream;
  refs.liveVideo.srcObject = stream;
  await refs.liveVideo.play();
  renderLiveOverlay();
  renderCapabilityStatus();
  return stream;
}

function setupMotionListeners() {
  if (state.motionActive) {
    return;
  }

  window.addEventListener("deviceorientation", (event) => {
    state.lastOrientation = {
      alpha: event.alpha,
      beta: event.beta,
      gamma: event.gamma,
      absolute: event.absolute,
    };

    refs.yawValue.textContent = degrees(event.alpha);
    refs.pitchValue.textContent = degrees(event.beta);
    refs.rollValue.textContent = degrees(event.gamma);
    renderLiveOverlay();
  });

  window.addEventListener("devicemotion", (event) => {
    const acc = event.accelerationIncludingGravity || event.acceleration || null;
    const magnitude = acc ? Math.hypot(acc.x || 0, acc.y || 0, acc.z || 0) : null;

    state.lastMotion = {
      acceleration: acc,
      magnitude,
      interval: event.interval || null,
    };

    refs.accValue.textContent = magnitude == null ? "--" : `${magnitude.toFixed(2)} m/s2`;
  });

  state.motionActive = true;
  renderCapabilityStatus();
}

async function requestMotionAccess() {
  let granted = true;

  try {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      granted = granted && (await DeviceOrientationEvent.requestPermission()) === "granted";
    }

    if (
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    ) {
      granted = granted && (await DeviceMotionEvent.requestPermission()) === "granted";
    }
  } catch {
    granted = false;
  }

  if (!granted && !state.capabilities.motion) {
    throw new Error("Gyro-/Motion-Zugriff wurde nicht freigegeben.");
  }

  setupMotionListeners();
  renderCapabilityStatus();
}

function grayscaleAt(data, index) {
  return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
}

function computeSharpness(imageData) {
  const { data, width, height } = imageData;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const centerIndex = (y * width + x) * 4;
      const leftIndex = centerIndex - 4;
      const rightIndex = centerIndex + 4;
      const upIndex = centerIndex - width * 4;
      const downIndex = centerIndex + width * 4;

      const laplacian =
        grayscaleAt(data, leftIndex) +
        grayscaleAt(data, rightIndex) +
        grayscaleAt(data, upIndex) +
        grayscaleAt(data, downIndex) -
        4 * grayscaleAt(data, centerIndex);

      sum += laplacian;
      sumSq += laplacian * laplacian;
      count += 1;
    }
  }

  if (!count) {
    return 0;
  }

  const mean = sum / count;
  return sumSq / count - mean * mean;
}

function createSignature(imageData, size = 24) {
  const { data, width, height } = imageData;
  const signature = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.floor((x / size) * width);
      const sourceY = Math.floor((y / size) * height);
      const index = (sourceY * width + sourceX) * 4;
      signature[y * size + x] = grayscaleAt(data, index);
    }
  }

  return signature;
}

function signatureDistance(signatureA, signatureB) {
  if (!signatureA || !signatureB || signatureA.length !== signatureB.length) {
    return 1;
  }

  let sum = 0;
  for (let index = 0; index < signatureA.length; index += 1) {
    sum += Math.abs(signatureA[index] - signatureB[index]);
  }

  return sum / signatureA.length / 255;
}

function estimatePose(frameIndex, totalFrames, scanType, orientation) {
  const progress = totalFrames <= 1 ? 0 : frameIndex / (totalFrames - 1);
  const yaw = Number.isFinite(orientation?.alpha)
    ? orientation.alpha
    : scanType === "object"
      ? -80 + progress * 160
      : -45 + progress * 90;
  const pitch = Number.isFinite(orientation?.beta) ? orientation.beta : 0;
  const roll = Number.isFinite(orientation?.gamma) ? orientation.gamma : 0;

  if (scanType === "object") {
    const angle = ((yaw - 90) * Math.PI) / 180;
    return {
      source: state.motionActive ? "gyro-estimate" : "path-estimate",
      position: {
        x: Number((Math.cos(angle) * 1.7).toFixed(2)),
        y: Number((1.35 + Math.sin(progress * Math.PI) * 0.18).toFixed(2)),
        z: Number((Math.sin(angle) * 1.7).toFixed(2)),
      },
      rotation: {
        yaw: Number(yaw.toFixed(1)),
        pitch: Number(pitch.toFixed(1)),
        roll: Number(roll.toFixed(1)),
      },
    };
  }

  return {
    source: state.motionActive ? "gyro-estimate" : "walk-estimate",
    position: {
      x: Number((-2.4 + progress * 4.8).toFixed(2)),
      y: 1.6,
      z: Number((1.4 * Math.sin(progress * Math.PI)).toFixed(2)),
    },
    rotation: {
      yaw: Number(yaw.toFixed(1)),
      pitch: Number(pitch.toFixed(1)),
      roll: Number(roll.toFixed(1)),
    },
  };
}

function snapshotVideoFrame() {
  const video = refs.liveVideo;
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }

  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));

  offscreenCanvas.width = width;
  offscreenCanvas.height = height;
  offscreenContext.drawImage(video, 0, 0, width, height);

  const analysisWidth = 192;
  const analysisHeight = Math.max(1, Math.round(height * (analysisWidth / width)));
  const analysisCanvas = document.createElement("canvas");
  const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
  analysisCanvas.width = analysisWidth;
  analysisCanvas.height = analysisHeight;
  analysisContext.drawImage(offscreenCanvas, 0, 0, analysisWidth, analysisHeight);
  const imageData = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight);

  return {
    dataUrl: offscreenCanvas.toDataURL("image/jpeg", 0.86),
    width,
    height,
    imageData,
  };
}

function renderFrameStrip() {
  if (!state.frames.length) {
    refs.frameStrip.className = "frame-strip empty-state";
    refs.frameStrip.textContent = "Noch keine Frames ausgewaehlt.";
    return;
  }

  refs.frameStrip.className = "frame-strip";
  refs.frameStrip.innerHTML = "";
  state.frameCards.clear();

  for (const frame of state.frames) {
    const quality = frame.quality || {};
    const card = document.createElement("figure");
    card.className = "frame-card";
    card.innerHTML = `
      <div class="frame-visual">
        <img src="${frame.dataUrl}" alt="Frame ${frame.frameId}" />
        <canvas class="frame-overlay"></canvas>
      </div>
      <figcaption>
        <strong>${frame.frameId}</strong>
        <span>${(frame.timestampMs / 1000).toFixed(1)} s</span>
        <span>Schaerfe ${Number(quality.sharpness || 0).toFixed(0)}</span>
        <span>Delta ${Number(quality.duplicateDistance || 0).toFixed(2)}</span>
        <span>Pose ${frame.pose?.source || "unbekannt"}</span>
      </figcaption>
    `;

    refs.frameStrip.append(card);
    state.frameCards.set(frame.frameId, card);
  }
}

function renderLiveOverlay() {
  const canvas = refs.liveOverlay;
  const video = refs.liveVideo;
  const width = video.clientWidth || canvas.clientWidth || 320;
  const height = video.clientHeight || canvas.clientHeight || 240;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(248, 250, 252, 0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, width - 48, height - 48);

  ctx.beginPath();
  ctx.moveTo(width / 2 - 18, height / 2);
  ctx.lineTo(width / 2 + 18, height / 2);
  ctx.moveTo(width / 2, height / 2 - 18);
  ctx.lineTo(width / 2, height / 2 + 18);
  ctx.stroke();

  ctx.fillStyle = "rgba(10, 16, 28, 0.72)";
  ctx.fillRect(18, 18, 260, 74);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "600 14px IBM Plex Sans, sans-serif";
  ctx.fillText(`Frames: ${state.frames.length}/${refs.frameBudget.value}`, 32, 42);
  ctx.fillText(`Yaw: ${refs.yawValue.textContent}`, 32, 62);
  ctx.fillText(`Depth: ${refs.depthValue.textContent}`, 32, 82);
}

async function captureFrameCandidate() {
  if (state.captureBusy || !state.scanning) {
    return;
  }

  state.captureBusy = true;
  try {
    const snapshot = snapshotVideoFrame();
    if (!snapshot) {
      return;
    }

    state.stats.candidates += 1;
    const sharpness = computeSharpness(snapshot.imageData);
    const signature = createSignature(snapshot.imageData);
    const duplicateDistance = state.frames.length
      ? Math.min(...state.frames.map((frame) => signatureDistance(signature, frame.signature)))
      : 1;

    if (sharpness < Number(refs.blurThreshold.value)) {
      state.stats.rejectedBlur += 1;
      updateStats();
      return;
    }

    if (duplicateDistance < Number(refs.duplicateThreshold.value)) {
      state.stats.rejectedDuplicate += 1;
      updateStats();
      return;
    }

    const timestampMs = Date.now() - state.scanStartedAt;
    const frameId = `frame-${String(state.frames.length + 1).padStart(2, "0")}`;
    const pose = estimatePose(
      state.frames.length,
      Math.max(2, Number(refs.frameBudget.value)),
      refs.scanType.value,
      state.lastOrientation,
    );

    const frame = {
      frameId,
      timestampMs,
      mimeType: "image/jpeg",
      base64Data: snapshot.dataUrl.split(",")[1],
      dataUrl: snapshot.dataUrl,
      width: snapshot.width,
      height: snapshot.height,
      signature,
      quality: {
        sharpness,
        duplicateDistance,
      },
      pose,
      sensor: {
        orientation: state.lastOrientation,
        motion: state.lastMotion,
      },
    };

    state.frames.push(frame);
    state.stats.accepted += 1;
    renderFrameStrip();
    updateStats();
    renderLiveOverlay();
    setStatus(
      `${frame.frameId} gespeichert. Schaerfe ${sharpness.toFixed(0)}, Delta ${duplicateDistance.toFixed(2)}.`,
    );

    if (state.frames.length >= Number(refs.frameBudget.value)) {
      stopScan("Frame-Budget erreicht. Bereit fuer den Transfer an den Laptop.");
    }
  } finally {
    state.captureBusy = false;
  }
}

function clearAnalysisViews() {
  state.analysis = null;
  refs.objectList.innerHTML = '<p class="placeholder">Noch keine Objekte erkannt.</p>';
  refs.summaryList.innerHTML = '<p class="placeholder">Noch keine Zusammenfassung.</p>';
  refs.problemList.innerHTML = '<p class="placeholder">Noch keine Probleme erkannt.</p>';
  refs.partsToolsList.innerHTML = '<p class="placeholder">Noch keine Teile- oder Werkzeughinweise.</p>';
  refs.nextStepsList.innerHTML = '<p class="placeholder">Noch keine Handlungsempfehlungen.</p>';
  refs.sceneNote.textContent =
    "Noch keine Analyse. Nach dem Laden und Auswerten eines Inbox-Scans werden Kamerastandorte und Objektanker hier visualisiert.";
  setRawResult("Noch keine Analyse.");
  drawScene();
}

function resetLocalScanState() {
  state.frames = [];
  state.frameCards.clear();
  state.currentUploadedScanId = null;
  state.stats = {
    candidates: 0,
    accepted: 0,
    rejectedBlur: 0,
    rejectedDuplicate: 0,
  };

  clearAnalysisViews();
  renderFrameStrip();
  updateStats();
}

function loadFramesIntoState(frames, preprocessing = null) {
  state.frames = (frames || []).map((frame) => ({
    frameId: frame.frameId,
    timestampMs: Number(frame.timestampMs) || 0,
    mimeType: frame.mimeType || "image/jpeg",
    base64Data: frame.base64Data,
    dataUrl: `data:${frame.mimeType || "image/jpeg"};base64,${frame.base64Data}`,
    width: Number(frame.width) || 0,
    height: Number(frame.height) || 0,
    quality: {
      sharpness: Number(frame.quality?.sharpness) || 0,
      duplicateDistance: Number(frame.quality?.duplicateDistance) || 0,
    },
    pose: frame.pose || null,
    sensor: frame.sensor || null,
    signature: null,
  }));

  state.stats = {
    candidates: Number(preprocessing?.stats?.candidates) || state.frames.length,
    accepted: Number(preprocessing?.stats?.accepted) || state.frames.length,
    rejectedBlur: Number(preprocessing?.stats?.rejectedBlur) || 0,
    rejectedDuplicate: Number(preprocessing?.stats?.rejectedDuplicate) || 0,
  };

  renderFrameStrip();
  updateStats();
  renderLiveOverlay();
}

async function startScan() {
  await ensureCamera();
  if (!state.motionActive && state.capabilities.motion) {
    try {
      await requestMotionAccess();
    } catch {
      setStatus("Scan startet ohne Gyro-Freigabe. Pose bleibt heuristisch.");
    }
  }

  resetLocalScanState();
  state.selectedScanId = null;
  setSelectedScanLabel("Noch keiner");
  state.scanning = true;
  state.scanStartedAt = Date.now();
  setStatus("Scan laeuft. Bewege das Smartphone langsam und gleichmaessig.");
  setTransferStatus("Neuer lokaler Scan aktiv. Nach dem Stopp kannst du ihn an den Laptop senden.");
  state.captureTimer = window.setInterval(captureFrameCandidate, Number(refs.captureInterval.value));
  renderLiveOverlay();
  renderInbox();
}

function stopScan(message = "Scan gestoppt.") {
  state.scanning = false;
  if (state.captureTimer) {
    window.clearInterval(state.captureTimer);
    state.captureTimer = null;
  }
  setStatus(message);
  renderLiveOverlay();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Serverfehler");
  }

  return payload;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Serverfehler");
  }
  return payload;
}

function buildScanTransferPayload() {
  return {
    deviceLabel: refs.deviceLabel.value.trim() || inferDeviceLabel(),
    sourceLabel: /iPhone|iPad|Android/i.test(navigator.userAgent) ? "Mobile Browser" : "Desktop Browser",
    scanType: refs.scanType.value,
    prompt: refs.scanPrompt.value.trim(),
    context: {
      app: "Hero Scan Copilot",
      depthSupport: state.capabilities.depth,
      poseMode: refs.poseMode.textContent,
      secureContext: state.capabilities.secureContext,
    },
    preprocessing: {
      stats: { ...state.stats },
      coveragePercent: coverageFromFrames(),
      poseMode: refs.poseMode.textContent,
      depthMode: refs.depthValue.textContent,
    },
    createdAt: new Date().toISOString(),
    frames: state.frames.map((frame) => ({
      frameId: frame.frameId,
      timestampMs: frame.timestampMs,
      mimeType: frame.mimeType,
      base64Data: frame.base64Data,
      width: frame.width,
      height: frame.height,
      quality: {
        sharpness: Number(frame.quality.sharpness.toFixed(1)),
        duplicateDistance: Number(frame.quality.duplicateDistance.toFixed(3)),
      },
      pose: frame.pose,
      sensor: frame.sensor,
    })),
  };
}

function renderInbox() {
  if (!state.inbox.length) {
    refs.inboxList.innerHTML = '<p class="placeholder">Noch keine Scan-Pakete vorhanden.</p>';
    return;
  }

  refs.inboxList.innerHTML = state.inbox
    .map((scan) => {
      const selected = scan.id === state.selectedScanId ? "selected" : "";
      const summary = scan.analysisSummary || "Noch nicht analysiert";
      const uploadedAt = scan.uploadedAt ? new Date(scan.uploadedAt).toLocaleString("de-DE") : "--";

      return `
        <article class="inbox-card ${selected}" data-scan-id="${scan.id}">
          <header>
            <strong>${scan.deviceLabel}</strong>
            <span>${scan.scanType}</span>
          </header>
          <p><strong>ID:</strong> ${scan.id}</p>
          <p><strong>Frames:</strong> ${scan.frameCount} | <strong>Status:</strong> ${scan.status}</p>
          <p><strong>Uebertragen:</strong> ${uploadedAt}</p>
          <p><strong>Summary:</strong> ${summary}</p>
          <div class="inbox-actions">
            <button class="secondary" data-action="load-scan" data-scan-id="${scan.id}">Scan laden</button>
            <button data-action="analyze-scan" data-scan-id="${scan.id}">
              ${scan.hasAnalysis ? "Neu analysieren" : "Hier analysieren"}
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

async function refreshInbox(preferredScanId = state.selectedScanId) {
  const payload = await fetchJson("/api/scans");
  state.inbox = payload.scans || [];
  renderInbox();

  if (!state.inbox.length) {
    setInboxStatus("Noch keine Scan-Pakete auf diesem Laptop gespeichert.");
    return;
  }

  setInboxStatus(`${state.inbox.length} Scan-Pakete auf diesem Laptop gefunden.`);
  if (!state.selectedScanId && preferredScanId) {
    state.selectedScanId = preferredScanId;
  }
  if (state.selectedScanId) {
    renderInbox();
  }
}

async function loadStoredScan(scanId) {
  const detail = await fetchJson(`/api/scans/${encodeURIComponent(scanId)}`);
  state.selectedScanId = detail.scan.id;
  state.currentUploadedScanId = detail.scan.id;
  setSelectedScanLabel(`${detail.scan.deviceLabel} | ${detail.scan.id}`);
  refs.scanType.value = detail.capture.scanType || refs.scanType.value;
  refs.scanPrompt.value = detail.capture.prompt || refs.scanPrompt.value;
  refs.deviceLabel.value = detail.capture.deviceLabel || refs.deviceLabel.value;
  loadFramesIntoState(detail.capture.frames, detail.capture.preprocessing);
  setTransferStatus(`Geladen aus der Laptop-Inbox: ${detail.scan.id}`);

  if (detail.analysisResult) {
    renderAnalysis(detail.analysisResult);
  } else {
    clearAnalysisViews();
  }

  renderInbox();
}

function drawFrameDetections() {
  if (!state.analysis?.analysis?.frame_detections) {
    return;
  }

  for (const frame of state.frames) {
    const card = state.frameCards.get(frame.frameId);
    if (!card) continue;

    const canvas = card.querySelector("canvas");
    const img = card.querySelector("img");
    if (!canvas || !img) continue;

    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.font = "12px monospace";

    const frameDetection = state.analysis.analysis.frame_detections.find(
      (entry) => entry.frame_id === frame.frameId,
    );
    if (!frameDetection) continue;

    for (const objectData of frameDetection.objects || []) {
      const box = objectData.box_2d;
      if (!Array.isArray(box) || box.length !== 4) continue;

      const [y0, x0, y1, x1] = box;
      const x = (x0 / 1000) * canvas.width;
      const y = (y0 / 1000) * canvas.height;
      const width = ((x1 - x0) / 1000) * canvas.width;
      const height = ((y1 - y0) / 1000) * canvas.height;

      ctx.strokeStyle = "#f97316";
      ctx.fillStyle = "rgba(10, 16, 28, 0.9)";
      ctx.strokeRect(x, y, width, height);
      const label = `${objectData.label} ${Math.round((objectData.confidence || 0) * 100)}%`;
      const textWidth = ctx.measureText(label).width + 10;
      ctx.fillRect(x, Math.max(0, y - 20), textWidth, 18);
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(label, x + 5, Math.max(13, y - 7));

      if (
        Array.isArray(objectData.representative_point) &&
        objectData.representative_point.length === 2
      ) {
        const [pointX, pointY] = objectData.representative_point;
        ctx.fillStyle = "#22c55e";
        ctx.beginPath();
        ctx.arc((pointX / 1000) * canvas.width, (pointY / 1000) * canvas.height, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function renderStackedList(element, title, items, fallback) {
  if (!items?.length) {
    element.innerHTML = `<p class="placeholder">${fallback}</p>`;
    return;
  }

  element.innerHTML = items
    .map((item) => `<div class="output-pill"><strong>${title}</strong><span>${item}</span></div>`)
    .join("");
}

function renderPartsTools(operations) {
  const parts = operations.parts || [];
  const tools = operations.tools || [];
  const items = [
    ...parts.map((item) => ({ type: "Teil", value: item })),
    ...tools.map((item) => ({ type: "Werkzeug", value: item })),
  ];

  if (!items.length) {
    refs.partsToolsList.innerHTML =
      '<p class="placeholder">Noch keine Teile- oder Werkzeughinweise.</p>';
    return;
  }

  refs.partsToolsList.innerHTML = items
    .map((item) => `<div class="output-pill"><strong>${item.type}</strong><span>${item.value}</span></div>`)
    .join("");
}

function renderNextSteps(operations) {
  const nextSteps = operations.nextSteps || [];
  const cost = operations.costEstimate;
  const cards = [];

  for (const step of nextSteps) {
    cards.push(`<div class="output-pill"><strong>Naechster Schritt</strong><span>${step}</span></div>`);
  }

  if (cost?.low != null && cost?.high != null) {
    const assumptions = (cost.assumptions || []).join("; ");
    cards.push(
      `<div class="output-pill"><strong>Kosten</strong><span>${cost.low} bis ${cost.high} ${cost.currency || "EUR"}${assumptions ? ` | ${assumptions}` : ""}</span></div>`,
    );
  }

  refs.nextStepsList.innerHTML = cards.length
    ? cards.join("")
    : '<p class="placeholder">Noch keine Handlungsempfehlungen.</p>';
}

function renderObjectList(objects) {
  if (!objects?.length) {
    refs.objectList.innerHTML = '<p class="placeholder">Noch keine Objekte erkannt.</p>';
    return;
  }

  refs.objectList.innerHTML = objects
    .map((objectData) => {
      const problems = objectData.problems?.length ? objectData.problems.join(" | ") : "kein akutes Problem";
      const useCases = objectData.useCases?.length ? objectData.useCases.join(" | ") : "kein spezifischer Use Case";
      return `
        <article class="object-card">
          <header>
            <strong>${objectData.label}</strong>
            <span>${Math.round(objectData.confidence * 100)}%</span>
          </header>
          <p>${objectData.category} | Anchor ${objectData.anchor.x}, ${objectData.anchor.y}, ${objectData.anchor.z}</p>
          <p>Probleme: ${problems}</p>
          <p>Use Cases: ${useCases}</p>
        </article>
      `;
    })
    .join("");
}

function projectPoint(point, bounds, viewport) {
  const safeWidth = Math.max(bounds.width, 1);
  const safeDepth = Math.max(bounds.depth, 1);
  const x = viewport.x + ((point.x + safeWidth / 2) / safeWidth) * viewport.width;
  const y = viewport.y + (1 - (point.z + safeDepth / 2) / safeDepth) * viewport.height;
  return { x, y };
}

function drawScene() {
  const canvas = refs.sceneCanvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#f4efe7";
  ctx.fillRect(0, 0, width, height);

  const leftViewport = { x: 26, y: 48, width: width / 2 - 46, height: height - 90 };
  const rightViewport = { x: width / 2 + 20, y: 48, width: width / 2 - 46, height: height - 90 };

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(23, 32, 51, 0.16)";
  ctx.lineWidth = 1;
  ctx.fillRect(leftViewport.x, leftViewport.y, leftViewport.width, leftViewport.height);
  ctx.strokeRect(leftViewport.x, leftViewport.y, leftViewport.width, leftViewport.height);
  ctx.fillRect(rightViewport.x, rightViewport.y, rightViewport.width, rightViewport.height);
  ctx.strokeRect(rightViewport.x, rightViewport.y, rightViewport.width, rightViewport.height);

  ctx.fillStyle = "#172033";
  ctx.font = "600 15px Space Grotesk, sans-serif";
  ctx.fillText("Top View", leftViewport.x, 28);
  ctx.fillText("Side View", rightViewport.x, 28);

  const objects = state.analysis?.scene?.objects || [];
  const cameras = state.analysis?.scene?.cameras || [];
  const shell = state.analysis?.scene?.shell || { width: 5, depth: 5, height: 2.8 };

  const bounds = {
    width: shell.width || 5,
    depth: shell.depth || 5,
    height: shell.height || 2.8,
  };

  for (let index = 0; index <= 8; index += 1) {
    const x = leftViewport.x + (index / 8) * leftViewport.width;
    const y = leftViewport.y + (index / 8) * leftViewport.height;
    ctx.strokeStyle = "rgba(23, 32, 51, 0.08)";
    ctx.beginPath();
    ctx.moveTo(x, leftViewport.y);
    ctx.lineTo(x, leftViewport.y + leftViewport.height);
    ctx.moveTo(leftViewport.x, y);
    ctx.lineTo(leftViewport.x + leftViewport.width, y);
    ctx.stroke();
  }

  for (const camera of cameras) {
    const position = camera.pose?.position;
    if (!position) continue;
    const projected = projectPoint(position, bounds, leftViewport);
    ctx.fillStyle = "#2563eb";
    ctx.beginPath();
    ctx.arc(projected.x, projected.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  const palette = {
    tool: "#2563eb",
    material: "#f97316",
    structure: "#22c55e",
    machine: "#7c3aed",
    fixture: "#14b8a6",
    risk: "#ef4444",
    safety: "#eab308",
    other: "#172033",
  };

  for (const objectData of objects) {
    const color = palette[objectData.category] || palette.other;
    const top = projectPoint(objectData.anchor, bounds, leftViewport);
    const sideX = rightViewport.x + ((objectData.anchor.x + bounds.width / 2) / bounds.width) * rightViewport.width;
    const sideY = rightViewport.y + (1 - objectData.anchor.y / bounds.height) * rightViewport.height;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(top.x, top.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sideX, sideY, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#172033";
    ctx.font = "12px IBM Plex Sans, sans-serif";
    ctx.fillText(objectData.label, top.x + 10, top.y - 8);
    ctx.fillText(objectData.label, sideX + 10, sideY - 8);
  }
}

function renderAnalysis(payload) {
  state.analysis = payload;
  setRawResult(payload);
  refs.sceneNote.textContent = `${payload.scene.note} ${payload.scene.shell.note}`;
  renderObjectList(payload.scene.objects);
  renderStackedList(
    refs.summaryList,
    "Summary",
    [payload.operations.summary, ...(payload.operations.useCases || [])],
    "Noch keine Zusammenfassung.",
  );
  renderStackedList(
    refs.problemList,
    "Signal",
    [...(payload.operations.problemSummary || []), ...(payload.operations.uncertainties || [])],
    "Noch keine Probleme erkannt.",
  );
  renderPartsTools(payload.operations);
  renderNextSteps(payload.operations);
  drawFrameDetections();
  drawScene();
}

async function uploadCurrentScan() {
  if (!state.frames.length) {
    setTransferStatus("Bitte zuerst einen Scan aufnehmen, bevor du Daten an den Laptop sendest.");
    return;
  }

  stopScan("Scan eingefroren. Das Paket wird an den Laptop uebertragen.");
  setTransferStatus("Scan-Paket wird an den Laptop gesendet...");

  const payload = await postJson("/api/ingest-scan", buildScanTransferPayload());
  state.currentUploadedScanId = payload.scan.id;
  state.selectedScanId = payload.scan.id;
  setSelectedScanLabel(`${payload.scan.deviceLabel} | ${payload.scan.id}`);
  setTransferStatus(`Upload erfolgreich. Scan ${payload.scan.id} liegt jetzt in der Laptop-Inbox.`);
  await refreshInbox(payload.scan.id);
}

async function analyzeSelectedStoredScan(scanId = state.selectedScanId || state.currentUploadedScanId) {
  if (!scanId) {
    setInboxStatus("Bitte zuerst einen Scan aus der Inbox laden oder vom Handy hochladen.");
    return;
  }

  setInboxStatus(`Analyse von ${scanId} laeuft auf diesem Laptop...`);
  setRawResult("Gemini analysiert den gespeicherten Scan auf diesem Laptop...");

  const payload = await postJson("/api/analyze-stored-scan", { scanId });
  state.selectedScanId = payload.scan.id;
  state.currentUploadedScanId = payload.scan.id;
  setSelectedScanLabel(`${payload.scan.deviceLabel} | ${payload.scan.id}`);
  renderAnalysis(payload.analysisResult);
  await refreshInbox(payload.scan.id);
  setInboxStatus(`Analyse abgeschlossen fuer ${payload.scan.id}.`);
}

refs.frameBudget.addEventListener("input", updateSliderLabels);
refs.captureInterval.addEventListener("input", updateSliderLabels);
refs.blurThreshold.addEventListener("input", updateSliderLabels);
refs.duplicateThreshold.addEventListener("input", updateSliderLabels);

refs.cameraButton.addEventListener("click", async () => {
  try {
    await ensureCamera();
    setStatus("Kamera aktiv. Du kannst jetzt den Scan starten.");
  } catch (error) {
    setStatus(error.message);
  }
});

refs.motionButton.addEventListener("click", async () => {
  try {
    await requestMotionAccess();
    setStatus("Gyro / Bewegung freigegeben.");
  } catch (error) {
    setStatus(error.message);
  }
});

refs.scanButton.addEventListener("click", async () => {
  try {
    await startScan();
  } catch (error) {
    setStatus(error.message);
  }
});

refs.stopScanButton.addEventListener("click", () => {
  stopScan("Scan manuell gestoppt.");
});

refs.sendScanButton.addEventListener("click", async () => {
  try {
    await uploadCurrentScan();
  } catch (error) {
    setTransferStatus(error.message);
  }
});

refs.refreshInboxButton.addEventListener("click", async () => {
  try {
    await refreshInbox();
  } catch (error) {
    setInboxStatus(error.message);
  }
});

refs.analyzeStoredButton.addEventListener("click", async () => {
  try {
    await analyzeSelectedStoredScan();
  } catch (error) {
    setInboxStatus(error.message);
    setRawResult(error.message);
  }
});

refs.inboxList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const { action, scanId } = button.dataset;
  if (!scanId) return;

  try {
    if (action === "load-scan") {
      setInboxStatus(`Lade ${scanId} aus der Laptop-Inbox...`);
      await loadStoredScan(scanId);
      setInboxStatus(`Scan ${scanId} wurde geladen.`);
    }

    if (action === "analyze-scan") {
      await loadStoredScan(scanId);
      await analyzeSelectedStoredScan(scanId);
    }
  } catch (error) {
    setInboxStatus(error.message);
    setRawResult(error.message);
  }
});

window.addEventListener("resize", renderLiveOverlay);

refs.deviceLabel.value = inferDeviceLabel();
updateSliderLabels();
probeCapabilities();
renderCapabilityStatus();
updateStats();
renderFrameStrip();
clearAnalysisViews();
drawScene();
refreshInbox().catch((error) => {
  setInboxStatus(error.message);
});
