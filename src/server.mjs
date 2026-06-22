import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PUBLIC_DIR = join(process.cwd(), "public");
const SCAN_DIR = join(process.cwd(), "data", "scans");
const MAX_STORED_FRAMES = 12;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function nowIso() {
  return new Date().toISOString();
}

function createScanId() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `scan-${stamp}-${suffix}`;
}

async function ensureScanDir() {
  await mkdir(SCAN_DIR, { recursive: true });
}

function scanFilePath(scanId) {
  return join(SCAN_DIR, `${scanId}.json`);
}

async function persistScanRecord(record) {
  await ensureScanDir();
  await writeFile(scanFilePath(record.id), JSON.stringify(record, null, 2), "utf8");
}

async function loadScanRecord(scanId) {
  await ensureScanDir();
  const file = scanFilePath(scanId);
  if (!existsSync(file)) {
    throw new Error(`Scan ${scanId} wurde auf diesem Rechner nicht gefunden.`);
  }

  return JSON.parse(await readFile(file, "utf8"));
}

function summarizeScanRecord(record) {
  return {
    id: record.id,
    status: record.status,
    deviceLabel: record.deviceLabel || "Unbekanntes Geraet",
    sourceLabel: record.sourceLabel || "Web Client",
    scanType: record.scanType || "room",
    frameCount: Array.isArray(record.frames) ? record.frames.length : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    uploadedAt: record.uploadedAt,
    prompt: record.prompt || "",
    preprocessing: record.preprocessing || null,
    hasAnalysis: Boolean(record.analysisResult),
    analysisSummary: record.analysisResult?.operations?.summary || "",
  };
}

async function listScanRecords() {
  await ensureScanDir();
  const entries = await readdir(SCAN_DIR, { withFileTypes: true });
  const records = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const record = JSON.parse(await readFile(join(SCAN_DIR, entry.name), "utf8"));
      records.push(record);
    } catch {
      // Skip malformed scan files rather than breaking the inbox.
    }
  }

  return records.sort((left, right) => {
    return String(right.uploadedAt || right.createdAt).localeCompare(String(left.uploadedAt || left.createdAt));
  });
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function stripDataUrlPrefix(value = "") {
  const marker = "base64,";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function sanitizeBase64(value = "") {
  return stripDataUrlPrefix(value).replace(/\s/g, "");
}

function inferMimeType(filename = "", fallback = "application/octet-stream") {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  return fallback;
}

function ensureApiKey() {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing. Add it before starting the app.");
  }
}

function parseJsonResponse(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

async function generateContent({ contents, generationConfig }) {
  ensureApiKey();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents,
        generationConfig,
      }),
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || "Gemini request failed.");
  }

  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return { text, raw: payload };
}

async function uploadFileToGemini({ base64Data, mimeType, displayName }) {
  ensureApiKey();
  const bytes = Buffer.from(sanitizeBase64(base64Data), "base64");

  const startResponse = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file: {
        display_name: displayName,
      },
    }),
  });

  if (!startResponse.ok) {
    const payload = await startResponse.json().catch(() => ({}));
    throw new Error(payload.error?.message || "Gemini file upload could not be started.");
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini file upload URL is missing.");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });

  const uploadPayload = await uploadResponse.json();
  if (!uploadResponse.ok) {
    throw new Error(uploadPayload.error?.message || "Gemini file upload failed.");
  }

  return uploadPayload.file;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function degreesToRadians(value = 0) {
  return (value * Math.PI) / 180;
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function addVectors(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtractVectors(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaleVector(vector, scalar) {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function distance3d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function multiplyMatrixVector(matrix, vector) {
  return {
    x: matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
    y: matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
    z: matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z,
  };
}

function multiplyMatrices(a, b) {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2],
    ],
    [
      a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
      a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
      a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2],
    ],
  ];
}

function rotationMatrixFromDegrees(rotation = {}) {
  const yaw = degreesToRadians(rotation.yaw || 0);
  const pitch = degreesToRadians(rotation.pitch || 0);
  const roll = degreesToRadians(rotation.roll || 0);

  const yawMatrix = [
    [Math.cos(yaw), 0, Math.sin(yaw)],
    [0, 1, 0],
    [-Math.sin(yaw), 0, Math.cos(yaw)],
  ];

  const pitchMatrix = [
    [1, 0, 0],
    [0, Math.cos(pitch), -Math.sin(pitch)],
    [0, Math.sin(pitch), Math.cos(pitch)],
  ];

  const rollMatrix = [
    [Math.cos(roll), -Math.sin(roll), 0],
    [Math.sin(roll), Math.cos(roll), 0],
    [0, 0, 1],
  ];

  return multiplyMatrices(yawMatrix, multiplyMatrices(pitchMatrix, rollMatrix));
}

function rayFromObservation(frame, objectData) {
  const representativePoint = Array.isArray(objectData.representative_point)
    ? objectData.representative_point
    : null;

  let pointX = 500;
  let pointY = 500;

  if (representativePoint?.length === 2) {
    pointX = clamp(Number(representativePoint[0]) || 500, 0, 1000);
    pointY = clamp(Number(representativePoint[1]) || 500, 0, 1000);
  } else if (Array.isArray(objectData.box_2d) && objectData.box_2d.length === 4) {
    const [y0, x0, y1, x1] = objectData.box_2d.map((value) => Number(value) || 0);
    pointX = clamp((x0 + x1) / 2, 0, 1000);
    pointY = clamp((y0 + y1) / 2, 0, 1000);
  }

  const normalizedX = (pointX / 1000 - 0.5) * 2;
  const normalizedY = (pointY / 1000 - 0.5) * 2;
  const width = Number(frame.width) || 960;
  const height = Number(frame.height) || 540;
  const aspect = width / Math.max(1, height);
  const horizontalFov = degreesToRadians(62);
  const tangentX = Math.tan(horizontalFov / 2);
  const tangentY = tangentX / Math.max(0.65, aspect);

  const localRay = normalizeVector({
    x: normalizedX * tangentX,
    y: -normalizedY * tangentY,
    z: 1,
  });

  const rotation = rotationMatrixFromDegrees(frame.pose?.rotation || {});
  const worldRay = normalizeVector(multiplyMatrixVector(rotation, localRay));

  return {
    representativePoint: [pointX, pointY],
    origin: frame.pose?.position || { x: 0, y: 1.6, z: 0 },
    direction: worldRay,
  };
}

function solve3x3(matrix, vector) {
  const m = matrix.map((row) => row.slice());
  const v = vector.slice();

  for (let pivot = 0; pivot < 3; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < 3; row += 1) {
      if (Math.abs(m[row][pivot]) > Math.abs(m[maxRow][pivot])) {
        maxRow = row;
      }
    }

    if (Math.abs(m[maxRow][pivot]) < 1e-6) {
      return null;
    }

    [m[pivot], m[maxRow]] = [m[maxRow], m[pivot]];
    [v[pivot], v[maxRow]] = [v[maxRow], v[pivot]];

    const pivotValue = m[pivot][pivot];
    for (let column = pivot; column < 3; column += 1) {
      m[pivot][column] /= pivotValue;
    }
    v[pivot] /= pivotValue;

    for (let row = 0; row < 3; row += 1) {
      if (row === pivot) continue;
      const factor = m[row][pivot];
      for (let column = pivot; column < 3; column += 1) {
        m[row][column] -= factor * m[pivot][column];
      }
      v[row] -= factor * v[pivot];
    }
  }

  return {
    x: v[0],
    y: v[1],
    z: v[2],
  };
}

function triangulatePoint(rays, fallbackDistance = 2.4) {
  if (!rays.length) {
    return null;
  }

  if (rays.length === 1) {
    return addVectors(rays[0].origin, scaleVector(rays[0].direction, fallbackDistance));
  }

  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];

  for (const ray of rays) {
    const d = normalizeVector(ray.direction);
    const matrix = [
      [1 - d.x * d.x, -d.x * d.y, -d.x * d.z],
      [-d.y * d.x, 1 - d.y * d.y, -d.y * d.z],
      [-d.z * d.x, -d.z * d.y, 1 - d.z * d.z],
    ];

    a[0][0] += matrix[0][0];
    a[0][1] += matrix[0][1];
    a[0][2] += matrix[0][2];
    a[1][0] += matrix[1][0];
    a[1][1] += matrix[1][1];
    a[1][2] += matrix[1][2];
    a[2][0] += matrix[2][0];
    a[2][1] += matrix[2][1];
    a[2][2] += matrix[2][2];

    b[0] += matrix[0][0] * ray.origin.x + matrix[0][1] * ray.origin.y + matrix[0][2] * ray.origin.z;
    b[1] += matrix[1][0] * ray.origin.x + matrix[1][1] * ray.origin.y + matrix[1][2] * ray.origin.z;
    b[2] += matrix[2][0] * ray.origin.x + matrix[2][1] * ray.origin.y + matrix[2][2] * ray.origin.z;
  }

  const point = solve3x3(a, b);
  if (point) {
    return point;
  }

  return addVectors(rays[0].origin, scaleVector(rays[0].direction, fallbackDistance));
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function defaultDistanceForCategory(category = "other") {
  const table = {
    structure: 3.2,
    material: 2.1,
    tool: 1.4,
    machine: 2.6,
    risk: 1.8,
    fixture: 2.2,
    safety: 1.9,
    other: 2.3,
  };
  return table[category] || 2.3;
}

function createObservation(frame, detection) {
  const ray = rayFromObservation(frame, detection);
  const fallbackDistance =
    Number(detection.depth_hint_m) > 0
      ? Number(detection.depth_hint_m)
      : defaultDistanceForCategory(detection.category);

  const worldPoint = triangulatePoint([ray], fallbackDistance);

  return {
    frameId: frame.frameId,
    timestampMs: frame.timestampMs,
    box2d: detection.box_2d || null,
    representativePoint: ray.representativePoint,
    maskPoints: Array.isArray(detection.mask_points) ? detection.mask_points : [],
    confidence: Number(detection.confidence) || 0,
    problem: detection.problem || "",
    notes: detection.notes || "",
    depthHintMeters: fallbackDistance,
    origin: ray.origin,
    direction: ray.direction,
    point: worldPoint,
  };
}

function chooseGroup(groups, detection, observation) {
  let bestGroup = null;
  let bestScore = Infinity;

  for (const group of groups) {
    if (group.instanceId && detection.instance_id && group.instanceId === detection.instance_id) {
      return group;
    }

    if (group.label !== detection.label || group.category !== detection.category) {
      continue;
    }

    const pointDistance = observation.point && group.anchor
      ? distance3d(observation.point, group.anchor)
      : 2;
    const confidencePenalty = Math.abs(group.confidence - observation.confidence);
    const score = pointDistance + confidencePenalty;

    if (score < bestScore) {
      bestScore = score;
      bestGroup = group;
    }
  }

  return bestScore < 1.8 ? bestGroup : null;
}

function buildSceneObjects(analysis, frames) {
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const groups = [];

  for (const frameDetection of analysis.frame_detections || []) {
    const frame = frameById.get(frameDetection.frame_id);
    if (!frame) continue;

    for (const detection of frameDetection.objects || []) {
      const observation = createObservation(frame, detection);
      const group = chooseGroup(groups, detection, observation);

      if (group) {
        group.observations.push(observation);
        group.confidence = Math.max(group.confidence, observation.confidence);
        group.problems = uniqueStrings([...group.problems, detection.problem]);
        group.partHints = uniqueStrings([...group.partHints, ...(detection.parts_hints || [])]);
        group.toolHints = uniqueStrings([...group.toolHints, ...(detection.tool_hints || [])]);
        group.uncertainties = uniqueStrings([...group.uncertainties, detection.uncertainty]);
        group.useCases = uniqueStrings([...group.useCases, ...(detection.use_cases || [])]);
        group.anchor = triangulatePoint(
          group.observations.map((item) => ({
            origin: item.origin,
            direction: item.direction,
          })),
          group.observations.reduce((sum, item) => sum + item.depthHintMeters, 0) /
            Math.max(1, group.observations.length),
        ) || group.anchor;
      } else {
        groups.push({
          id: detection.instance_id || `scene-${groups.length + 1}`,
          instanceId: detection.instance_id || "",
          label: detection.label || "Objekt",
          category: detection.category || "other",
          confidence: observation.confidence,
          notes: detection.notes || "",
          problems: uniqueStrings([detection.problem]),
          partHints: uniqueStrings(detection.parts_hints || []),
          toolHints: uniqueStrings(detection.tool_hints || []),
          uncertainties: uniqueStrings([detection.uncertainty]),
          useCases: uniqueStrings(detection.use_cases || []),
          observations: [observation],
          anchor: observation.point,
        });
      }
    }
  }

  return groups.map((group) => {
    const rays = group.observations
      .filter((observation) => observation.origin && observation.direction)
      .map((observation) => ({
        origin: observation.origin,
        direction: observation.direction,
      }));

    const depthFallback = group.observations.reduce((sum, observation) => sum + observation.depthHintMeters, 0) /
      Math.max(1, group.observations.length);

    const anchor = triangulatePoint(rays, depthFallback) || group.anchor || { x: 0, y: 1.4, z: 0 };

    return {
      id: group.id,
      label: group.label,
      category: group.category,
      confidence: Number(group.confidence.toFixed(2)),
      anchor: {
        x: Number(anchor.x.toFixed(2)),
        y: Number(anchor.y.toFixed(2)),
        z: Number(anchor.z.toFixed(2)),
      },
      notes: group.notes,
      problems: group.problems,
      partHints: group.partHints,
      toolHints: group.toolHints,
      uncertainties: group.uncertainties,
      useCases: group.useCases,
      observationCount: group.observations.length,
      frames: group.observations.map((observation) => observation.frameId),
    };
  });
}

function buildSceneShell(scanType, frames, sceneObjects) {
  const coverage = frames.length >= 6 ? "good" : frames.length >= 4 ? "medium" : "light";
  const maxDistance = sceneObjects.reduce((current, objectData) => {
    return Math.max(current, Math.abs(objectData.anchor.x), Math.abs(objectData.anchor.z));
  }, 1.4);

  if (scanType === "object") {
    return {
      type: "object-orbit",
      width: Number((Math.max(1.8, maxDistance * 2.1)).toFixed(1)),
      depth: Number((Math.max(1.8, maxDistance * 2.1)).toFixed(1)),
      height: 2.2,
      coverage,
      note: "Ohne echte Depth-API wird die Objekt-Huelle aus Kamerabahn und Erkennungen geschaetzt.",
    };
  }

  return {
    type: "room-shell",
    width: Number((Math.max(4.2, maxDistance * 2.7)).toFixed(1)),
    depth: Number((Math.max(4.2, maxDistance * 2.7)).toFixed(1)),
    height: 2.8,
    coverage,
    note: "Die Raumhuelle ist ein heuristisches Scan-Volumen. Mit WebXR/Depth kann sie spaeter metrisch werden.",
  };
}

function buildOperationsOutput(analysis, sceneObjects) {
  const globalFindings = analysis.global_findings || {};
  const sceneProblems = uniqueStrings(sceneObjects.flatMap((objectData) => objectData.problems));
  const sceneParts = uniqueStrings(sceneObjects.flatMap((objectData) => objectData.partHints));
  const sceneTools = uniqueStrings(sceneObjects.flatMap((objectData) => objectData.toolHints));
  const sceneUseCases = uniqueStrings(sceneObjects.flatMap((objectData) => objectData.useCases));
  const sceneUncertainties = uniqueStrings(sceneObjects.flatMap((objectData) => objectData.uncertainties));

  return {
    summary: analysis.scan_summary || "Keine Zusammenfassung verfuegbar.",
    problemSummary: uniqueStrings([...(globalFindings.problems || []), ...sceneProblems]),
    parts: uniqueStrings([...(globalFindings.parts || []), ...sceneParts]),
    tools: uniqueStrings([...(globalFindings.tools || []), ...sceneTools]),
    useCases: uniqueStrings([...(globalFindings.use_cases || []), ...sceneUseCases]),
    nextSteps: uniqueStrings(globalFindings.next_steps || []),
    uncertainties: uniqueStrings([...(globalFindings.uncertainties || []), ...sceneUncertainties]),
    costEstimate: globalFindings.cost_range || null,
  };
}

async function analyzeImage(body) {
  const { base64Data, fileName = "image.jpg", prompt, focus = "construction-site" } = body;

  if (!base64Data) {
    throw new Error("No image data received.");
  }

  const mimeType = inferMimeType(fileName, "image/jpeg");
  const defaultPrompt =
    `Analyze this image for a craftsman workflow. ` +
    `Return strict JSON with this shape: ` +
    `{"summary":"string","objects":[{"label":"string","confidence":0-1,"box_2d":[ymin,xmin,ymax,xmax],"notes":"string","category":"tool|material|structure|machine|safety|other"}],"next_actions":["string"]}. ` +
    `Use box_2d normalized to 0-1000 and focus on ${focus}.`;

  const result = await generateContent({
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: sanitizeBase64(base64Data),
            },
          },
          {
            text: prompt || defaultPrompt,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  return parseJsonResponse(result.text);
}

async function analyzeVideoFrames(body) {
  const { frames, prompt, focus = "construction-site" } = body;

  if (!Array.isArray(frames) || !frames.length) {
    throw new Error("No video frames received.");
  }

  const parts = [];
  for (const frame of frames) {
    parts.push({
      text: `Frame ${frame.frameId || "frame"} at ${frame.timestampLabel || `${frame.timestampSec || 0}s`}`,
    });
    parts.push({
      inline_data: {
        mime_type: frame.mimeType || "image/jpeg",
        data: sanitizeBase64(frame.base64Data),
      },
    });
  }

  parts.push({
    text:
      prompt ||
      `Analyze these ordered construction frames and return strict JSON with this shape: ` +
        `{"summary":"string","site_state":"string","key_objects":[{"label":"string","confidence":0-1,"why_it_matters":"string"}],"frames":[{"timestampSec":number,"timestampLabel":"string","observations":["string"],"objects":[{"label":"string","confidence":0-1,"status":"string"}]}],"recommendations":["string"]}. ` +
        `Focus on ${focus}.`,
  });

  const result = await generateContent({
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  return parseJsonResponse(result.text);
}

async function analyzeScan(body) {
  const {
    frames,
    scanType = "room",
    prompt = "",
    context = {},
  } = body;

  if (!Array.isArray(frames) || !frames.length) {
    throw new Error("No scan frames received.");
  }

  const selectedFrames = frames.slice(0, 12);
  const parts = [
    {
      text:
        `You are helping a craftsman and construction workflow. ` +
        `The user is scanning a ${scanType}. ` +
        `Return strict JSON with this shape: ` +
        `{"scan_summary":"string","scene_type":"room|object|site|unknown","frame_detections":[{"frame_id":"string","frame_summary":"string","objects":[{"instance_id":"string","label":"string","category":"tool|material|structure|machine|fixture|risk|safety|other","confidence":0-1,"box_2d":[ymin,xmin,ymax,xmax],"representative_point":[x,y],"mask_points":[[x,y]],"depth_hint_m":number,"problem":"string","notes":"string","parts_hints":["string"],"tool_hints":["string"],"use_cases":["string"],"uncertainty":"string"}]}],"global_findings":{"problems":["string"],"parts":["string"],"tools":["string"],"use_cases":["string"],"uncertainties":["string"],"next_steps":["string"],"cost_range":{"currency":"EUR","low":number,"high":number,"assumptions":["string"]}}}. ` +
        `Use coordinates normalized to 0-1000. ` +
        `If the same physical object appears across frames, reuse the same instance_id whenever possible. ` +
        `Mask points are optional and should contain 4 to 10 representative contour points only.`,
    },
  ];

  for (const frame of selectedFrames) {
    const rotation = frame.pose?.rotation || {};
    const position = frame.pose?.position || {};
    parts.push({
      text:
        `Frame metadata | frame_id=${frame.frameId} | timestamp_ms=${frame.timestampMs} | ` +
        `sharpness=${frame.quality?.sharpness ?? "unknown"} | duplicate_distance=${frame.quality?.duplicateDistance ?? "unknown"} | ` +
        `pose_source=${frame.pose?.source || "unknown"} | x=${position.x ?? "unknown"} | y=${position.y ?? "unknown"} | z=${position.z ?? "unknown"} | ` +
        `yaw=${rotation.yaw ?? "unknown"} | pitch=${rotation.pitch ?? "unknown"} | roll=${rotation.roll ?? "unknown"}`,
    });
    parts.push({
      inline_data: {
        mime_type: frame.mimeType || "image/jpeg",
        data: sanitizeBase64(frame.base64Data),
      },
    });
  }

  parts.push({
    text:
      `Extra context: ${JSON.stringify(context)}. ` +
      `User focus: ${prompt || "Find objects, likely issues, parts, tools, uncertainties, and rough cost drivers."}`,
  });

  const result = await generateContent({
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.15,
    },
  });

  const analysis = parseJsonResponse(result.text);
  const sceneObjects = buildSceneObjects(analysis, selectedFrames);
  const operations = buildOperationsOutput(analysis, sceneObjects);
  const sceneShell = buildSceneShell(scanType, selectedFrames, sceneObjects);

  return {
    model: GEMINI_MODEL,
    scanType,
    preprocessing: {
      totalFrames: selectedFrames.length,
      poseSource: selectedFrames[0]?.pose?.source || "unknown",
    },
    analysis,
    scene: {
      shell: sceneShell,
      cameras: selectedFrames.map((frame) => ({
        frameId: frame.frameId,
        timestampMs: frame.timestampMs,
        pose: frame.pose || null,
      })),
      objects: sceneObjects,
      note:
        "Ohne native AR-/SLAM-Posen bleibt die 3D-Zuordnung heuristisch. Mit WebXR- oder nativer Depth/Pose wird sie deutlich genauer.",
    },
    operations,
  };
}

async function analyzeFullVideo(body) {
  const { base64Data, fileName = "video.mp4", prompt } = body;
  if (!base64Data) {
    throw new Error("No video data received.");
  }

  const mimeType = inferMimeType(fileName, "video/mp4");
  const file = await uploadFileToGemini({
    base64Data,
    mimeType,
    displayName: fileName,
  });

  const result = await generateContent({
    contents: [
      {
        parts: [
          {
            file_data: {
              mime_type: file.mime_type || mimeType,
              file_uri: file.uri,
            },
          },
          {
            text:
              prompt ||
              "Summarize this construction video, identify important visible objects or materials, point out likely issues, and suggest what a craftsman should inspect next. Return plain text.",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
    },
  });

  return {
    summary: result.text,
    fileUri: file.uri,
    mimeType: file.mime_type || mimeType,
  };
}

function sanitizeIncomingFrames(frames) {
  return (frames || []).slice(0, MAX_STORED_FRAMES).map((frame, index) => ({
    frameId: frame.frameId || `frame-${String(index + 1).padStart(2, "0")}`,
    timestampMs: Number(frame.timestampMs) || 0,
    mimeType: frame.mimeType || "image/jpeg",
    base64Data: sanitizeBase64(frame.base64Data || ""),
    width: Number(frame.width) || 0,
    height: Number(frame.height) || 0,
    quality: {
      sharpness: Number(frame.quality?.sharpness) || 0,
      duplicateDistance: Number(frame.quality?.duplicateDistance) || 0,
    },
    pose: frame.pose || null,
    sensor: frame.sensor || null,
  })).filter((frame) => frame.base64Data);
}

async function ingestScan(body) {
  const frames = sanitizeIncomingFrames(body.frames);
  if (!frames.length) {
    throw new Error("Es wurden keine relevanten Scan-Frames uebertragen.");
  }

  const timestamp = nowIso();
  const record = {
    id: createScanId(),
    status: "uploaded",
    deviceLabel: body.deviceLabel || "Unbekanntes Geraet",
    sourceLabel: body.sourceLabel || "Mobile Capture",
    scanType: body.scanType || "room",
    prompt: body.prompt || "",
    context: body.context || {},
    preprocessing: body.preprocessing || null,
    frames,
    createdAt: body.createdAt || timestamp,
    uploadedAt: timestamp,
    updatedAt: timestamp,
    analysisResult: null,
    analysisError: null,
  };

  await persistScanRecord(record);
  return {
    message: "Scan-Paket auf dem Laptop gespeichert.",
    scan: summarizeScanRecord(record),
  };
}

async function getScanDetail(scanId) {
  const record = await loadScanRecord(scanId);
  return {
    scan: summarizeScanRecord(record),
    capture: {
      deviceLabel: record.deviceLabel,
      sourceLabel: record.sourceLabel,
      scanType: record.scanType,
      prompt: record.prompt,
      context: record.context,
      preprocessing: record.preprocessing,
      frames: record.frames,
    },
    analysisResult: record.analysisResult,
    analysisError: record.analysisError,
  };
}

async function analyzeStoredScan(body) {
  const { scanId } = body;
  if (!scanId) {
    throw new Error("scanId fehlt.");
  }

  const record = await loadScanRecord(scanId);
  const result = await analyzeScan({
    frames: record.frames,
    scanType: record.scanType,
    prompt: record.prompt,
    context: {
      ...record.context,
      deviceLabel: record.deviceLabel,
      sourceLabel: record.sourceLabel,
      analysisMode: "laptop-inbox",
    },
  });

  record.status = "analyzed";
  record.analysisResult = result;
  record.analysisError = null;
  record.updatedAt = nowIso();
  await persistScanRecord(record);

  return {
    message: "Scan wurde auf diesem Laptop analysiert.",
    scan: summarizeScanRecord(record),
    analysisResult: result,
  };
}

function serveStatic(req, res) {
  const { pathname } = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const resolvedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(PUBLIC_DIR, resolvedPath));

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const extension = extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && pathname === "/api/scans") {
      const records = await listScanRecords();
      json(res, 200, {
        scans: records.map((record) => summarizeScanRecord(record)),
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/scans/")) {
      const scanId = decodeURIComponent(pathname.slice("/api/scans/".length));
      const payload = await getScanDetail(scanId);
      json(res, 200, payload);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/ingest-scan") {
      const payload = await ingestScan(await readJsonBody(req));
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/api/analyze-stored-scan") {
      const payload = await analyzeStoredScan(await readJsonBody(req));
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/api/analyze-image") {
      const payload = await analyzeImage(await readJsonBody(req));
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/api/analyze-video-frames") {
      const payload = await analyzeVideoFrames(await readJsonBody(req));
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/api/analyze-scan") {
      const payload = await analyzeScan(await readJsonBody(req));
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/api/analyze-full-video") {
      const payload = await analyzeFullVideo(await readJsonBody(req));
      json(res, 200, payload);
      return;
    }

    json(res, 404, { error: "Route not found." });
  } catch (error) {
    json(res, 500, { error: error.message || "Unknown server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gemini vision demo running on http://${HOST}:${PORT}`);
});
