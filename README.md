# Hero Scan Copilot

> **Hackathon demo** — scan a room or object with your phone, let Gemini 2.5 Flash turn the frames into structured 3D insights.

## What it is

Hero Scan Copilot is a multimodal AI demo built at a hackathon. A phone captures scan frames of a room or object; a laptop Node.js server receives them, filters blurry and duplicate frames, and sends the relevant frames to the Gemini 2.5 Flash generateContent + Files API. Gemini returns structured JSON with bounding boxes, 3D object anchors, and actionable repair hints (parts, tools, cost ranges). A lightweight scene graph is assembled on the server via multi-frame triangulation.

## Features

- **On-device pre-filtering** — blur score and image-distance heuristics drop bad frames before upload
- **Gemini structured output** — bounding boxes, representative/mask points, problems, parts, tools, uncertainties, next steps, cost ranges
- **3D scene graph** — heuristic object fusion across frames using Gaussian-elimination triangulation; top-view and side-view rendering
- **Zero-dependency backend** — 1 000+ line Node.js server using only stdlib `http` (no framework, no npm packages)
- **Persistent scan inbox** — scans stored as JSON files under `data/scans/` and reloadable from the UI

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 18+ (ESM, stdlib `http` only) |
| Frontend | Vanilla JS (no bundler) |
| AI | Gemini 2.5 Flash REST API (`generateContent` + Files API) |
| Persistence | Local JSON files (`data/scans/`) |

## How it works

```
Phone camera → blur/duplicate filter (on-device)
    → POST /api/ingest-scan (laptop inbox)
        → POST /api/analyze-stored-scan
            → Gemini 2.5 Flash (structured JSON)
                → triangulation math → 3D scene graph → UI
```

## Running locally

**Requirements:** Node.js 18+ (built-in `fetch`), a Gemini API key.

```bash
# 1. Copy the env template and add your key
cp .env.example .env
# edit .env and set GEMINI_API_KEY=<your key>

# 2. Start the server
npm start

# 3. Open in browser
open http://127.0.0.1:3000
```

Then open the same URL on your phone (same LAN) to use it as the capture device. See "Wichtige Grenzen" below for HTTPS / tunnel notes.

---

## Deutsche Dokumentation

Web-First Hackathon-Prototyp mit klarer Geraetetrennung:

- Smartphone: Kamera, Gyro, optionaler Depth-/LiDAR-Capability-Check, Frame-Auswahl
- Laptop: Inbox fuer eingehende Scans, Gemini-Analyse, 3D-Zuordnung, Handwerker-Insights

## Start

```bash
export GEMINI_API_KEY=dein_key
npm start
```

Dann die App im Browser oeffnen:

```text
http://127.0.0.1:3000
```

## Neuer Ablauf

1. Auf dem Handy scannt ihr einen Raum oder ein Objekt.
2. Die Web-App filtert unscharfe und doppelte Frames direkt auf dem Geraet heraus.
3. Danach sendet ihr nur das relevante Scan-Paket an den Laptop.
4. Der Laptop speichert den Scan in einer lokalen Inbox.
5. Erst auf dem Laptop startet ihr die eigentliche Gemini-Analyse und die 3D-Zuordnung.

## API-Endpunkte

- `POST /api/ingest-scan` — speichert ein Scan-Paket auf dem Laptop
- `GET /api/scans` — listet alle gespeicherten Scan-Pakete
- `GET /api/scans/:id` — laedt ein gespeichertes Paket inklusive Frames
- `POST /api/analyze-stored-scan` — analysiert einen gespeicherten Scan mit Gemini; Ergebnis wird zurueckgeschrieben
- `POST /api/analyze-scan` — analysiert einen Scan direkt aus dem Request-Body (kein vorheriger Ingest noetig)
- `POST /api/analyze-image` — analysiert ein einzelnes Bild (base64) mit Gemini
- `POST /api/analyze-video-frames` — analysiert eine Folge von Video-Frames (base64, ohne File-Upload)
- `POST /api/analyze-full-video` — laedt ein ganzes Video ueber die Gemini Files API hoch und analysiert es

## Was dieser MVP heute kann

### Mobile Capture

- Rueckkamera-Zugriff
- Gyro-/Motion-Zugriff
- Capture-Intervall fuer automatische Frame-Auswahl
- Blur-Filter ueber Schaerfe-Score
- Duplicate-Filter ueber Bilddistanz-Heuristik

### Laptop Inbox

- speichert Scan-Pakete als lokale JSON-Dateien unter `data/scans`
- laedt hochgeladene Scans wieder in die UI
- startet Analyse gezielt erst auf dem Laptop

### Gemini-Analyse

- strukturiertes JSON pro Scan
- Bounding Boxes, repraesentative Punkte und optionale Maskenpunkte
- globale Erkenntnisse fuer:
  - Probleme
  - Teile
  - Werkzeuge
  - Unsicherheiten
  - naechste Schritte
  - Kostenspannen

### 3D-Szene

- heuristische Objekt-Fusion ueber mehrere Frames
- einfache 3D-Anker aus Kamerapose und Bildpunkten
- Top- und Side-View fuer Kamera- und Objektpositionen

## Wichtige Grenzen

- Kamera und Sensoren brauchen auf Smartphones HTTPS oder localhost.
- Wenn ihr die Seite ueber einen Tunnel oeffnet, ist der Transport nicht rein lokal im WLAN, auch wenn die Auswertung auf diesem Laptop stattfindet.
- Fuer echte lokale Direktuebertragung ohne Tunnel braucht ihr spaeter LAN-HTTPS, WebRTC oder einen nativen/hybriden Capture-Pfad.
- Echte LiDAR-/Depth-Daten sind im mobilen Browser weiterhin geraete- und browserabhaengig.

## Empfohlene Demo

1. Handy oeffnet die Seite und nimmt den Scan auf
2. Handy sendet den Scan an die Laptop-Inbox
3. Laptop laedt den gespeicherten Scan
4. Laptop startet Analyse
5. Team zeigt Scene Graph, Probleme, Teile, Werkzeuge und Kosten-Hinweise
