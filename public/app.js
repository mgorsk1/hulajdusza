const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const CC_KEY = "hulajdusza.cc";
const MAX_DOCS = 2; // zdjęcia dokumentujące złe parkowanie (oprócz zdjęcia kodu QR)

const VIEWS = ["start", "doc", "scan", "manual", "email", "confirm", "done"];
const STEP_OF = { start: 1, scan: 1, manual: 1, doc: 2, email: 3, confirm: 4 };
const STEP_TITLE = { 1: "Kod QR", 2: "Zdjęcie hulajnogi", 3: "Kopia", 4: "Potwierdzenie" };

const plural = (n, one, few, many) =>
  n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? few : many;
const reportsWord = (n) => `${n} ${plural(n, "zgłoszenie", "zgłoszenia", "zgłoszeń")}`;
const photosWord = (n) => `${n} ${plural(n, "zdjęcie", "zdjęcia", "zdjęć")}`;

let config = { operators: [], turnstileSiteKey: "" };
// scooters: gotowe hulajnogi { uid, code, operator, operatorName, id, hasQr, photos: [{ blob, url }] }, przy hasQr photos[0] = zdjęcie kodu QR
let scooters = [];
// current: hulajnoga w trakcie dodawania { status: analyzing|ok|noqr|needop|error|reported|onlist, qr, docs, code, operator, operatorName, id }
let current = null;
let loc = null; // { lat, lng, accuracy, street }
let cc = "";
let whenIso = null;
let tsToken = "";
let tsWidget = null;
let uid = 0;
let quota = null;

const opByKey = (k) => config.operators.find((o) => o.key === k);
const dotColor = (op) => (isDark() ? op.dark : op.color);
const idKey = (x) => `${x.operator}:${String(x.id).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;

const configReady = fetch("/api/config").then((r) => r.json()).then((c) => {
  config = c;
  $("m-op").innerHTML = c.operators.map((o) => `<option value="${o.key}">${esc(o.name)}</option>`).join("");
  renderStart();
});

function show(name) {
  console.log(`[View] Przełączenie widoku -> "${name}"`);
  VIEWS.forEach((v) => $("v-" + v).classList.toggle("hidden", v !== name));
  const n = STEP_OF[name];
  $("steps").classList.toggle("hidden", !n);
  if (n) {
    [...$("steps-bar").children].forEach((seg, i) => seg.classList.toggle("on", i < n));
    $("steps-label").textContent = `Krok ${n} z 4 · ${STEP_TITLE[n]}`;
  }
  scrollTo(0, 0);
}

/* ---------- Lokalizacja ---------- */
function locate() {
  console.log("[Loc] Pobieranie pozycji GPS (getCurrentPosition)...");
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn("[Loc] Brak API geolokalizacji w przeglądarce.");
      return resolve(null);
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        loc = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), street: null };
        console.log(`[Loc] Pozycja GPS ustalona: ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)} (±${loc.accuracy} m)`);
        resolve(loc);
      },
      (err) => {
        console.warn("[Loc] Błąd geolokalizacji:", err.message || err);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  }).then((l) => {
    renderLoc();
    if (l) resolveStreet(l);
    return l;
  });
}
async function resolveStreet(l) {
  console.log(`[Loc] Odpytuję /api/geocode?lat=${l.lat}&lng=${l.lng}...`);
  try {
    const r = await fetch(`/api/geocode?lat=${l.lat}&lng=${l.lng}`);
    const d = await r.json();
    l.street = r.ok ? d.street || "" : r.status === 422 ? "poza Warszawą" : "";
    console.log("[Loc] Adres ustalony:", l.street || "(brak nazwy)");
  } catch (err) {
    console.warn("[Loc] Błąd geokodowania:", err);
    l.street = "";
  }
  renderLoc();
}
function renderLoc() {
  const where = loc?.street === null ? "ustalam adres…" : loc?.street || "adres nieustalony";
  $("loc-start").textContent = loc
    ? `Lokalizacja: ${where} · ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} (±${loc.accuracy} m)`
    : "Brak lokalizacji – zezwól na dostęp do GPS (dotknij, by spróbować ponownie).";
}
$("loc-start").onclick = () => locate();

/* ---------- Limity zgłoszeń ---------- */
const quotaText = (q) =>
  q.limitedBy === "monthly" ? "Limit zgłoszeń na ten miesiąc został wyczerpany. Wróć w przyszłym miesiącu." : "Limit zgłoszeń na dziś został wyczerpany. Wróć jutro.";

// Pasek pod nawigacją pokazujemy tylko wtedy, gdy limit jest wyczerpany
function setQuota(q) {
  if (!q) return;
  quota = q;
  const exhausted = q.remaining === 0;
  $("quota-bar").classList.toggle("hidden", !exhausted);
  $("quota").textContent = exhausted ? quotaText(q) : "";
  renderStart();
}
const refreshQuota = () => fetch("/api/quota").then((r) => r.json()).then(setQuota).catch(() => {});
function duplicateMessage(d) {
  if (d.error === "duplicate_in_request") return "Ta sama hulajnoga jest na liście dwa razy. Usuń jedno zgłoszenie.";
  const ids = (d.duplicates || []).map((x) => x.id).join(", ");
  return `Te hulajnogi były już dziś zgłoszone: ${ids}. Wróć i usuń je z listy.`;
}
function quotaMessage(d) {
  const q = d.quota;
  const daily = d.error === "quota_daily";
  if (!q || q.remaining === 0) return quotaText(q ?? { limitedBy: daily ? "daily" : "monthly" });
  return `${daily ? "Na dziś" : "W tym miesiącu"} zostało ${reportsWord(q.remaining)}, a ta wiadomość wymaga ${d.needed} (po jednym na operatora). Usuń część hulajnóg.`;
}

/* ---------- Zdjęcia ---------- */
function drawScaled(bmp, max) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp._src ?? bmp, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.7));
async function makePhoto(src) {
  // src: ImageBitmap albo <video> (klatka z podglądu)
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  const blob = await toBlob(drawScaled({ width: w, height: h, _src: src }, 1280));
  return { blob, url: URL.createObjectURL(blob) };
}
const freePhotos = (photos) => photos.forEach((p) => URL.revokeObjectURL(p.url));
function discardCurrent() {
  if (!current) return;
  freePhotos([current.qr, ...current.docs].filter(Boolean));
  current = null;
}

/* Mobilna konsola debugowania dla ?debug=1 na telefonie oraz pamięć podręczna */
const urlParams = new URLSearchParams(location.search);
if (urlParams.has("debug") || urlParams.has("console") || localStorage.getItem("debug") === "1") {
  if (urlParams.has("debug") || urlParams.has("console")) {
    try { localStorage.setItem("debug", "1"); } catch {}
  }
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/eruda";
  s.onload = () => {
    window.eruda?.init();
    console.log("%c[DEBUG] Eruda DevTools aktywne!", "color:#10b981; font-weight:bold; font-size:14px;");
  };
  document.head.append(s);
}

// Globalny toggle do debugowania z poziomu konsoli lub UI
window.toggleDebug = () => {
  const cur = localStorage.getItem("debug") === "1";
  if (cur) {
    localStorage.removeItem("debug");
    alert("Tryb debug wyłączony. Przeładowuję stronę...");
  } else {
    localStorage.setItem("debug", "1");
    alert("Tryb debug włączony! Przeładowuję stronę z Eruda...");
  }
  location.reload();
};

// Potrójne kliknięcie w logo włącza/wyłącza tryb debugowania na telefonie
let logoClicks = 0;
let logoTimer = null;
document.querySelector("header a")?.addEventListener("click", (e) => {
  logoClicks++;
  clearTimeout(logoTimer);
  logoTimer = setTimeout(() => { logoClicks = 0; }, 600);
  if (logoClicks >= 3) {
    logoClicks = 0;
    e.preventDefault();
    window.toggleDebug();
  }
});

console.log("%c[Hulajdusza Init] Start aplikacji", "color:#3b82f6; font-weight:bold; font-size:14px;");
console.log("[Sys Info]", {
  ua: navigator.userAgent,
  isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  screen: `${window.innerWidth}x${window.innerHeight} (dpr: ${window.devicePixelRatio})`,
  wasm: typeof WebAssembly === "object",
  worker: typeof Worker !== "undefined",
  barcodeDetector: "BarcodeDetector" in window,
  debugMode: localStorage.getItem("debug") === "1",
});

/* Odczyt QR w przeglądarce: BarcodeDetector albo jsQR z CDN */
let jsqrPromise;
function loadJsQR() {
  jsqrPromise ??= new Promise((res, rej) => {
    console.log("[QR Lib] Ładowanie jsQR z CDN...");
    const t0 = performance.now();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
    s.onload = () => {
      console.log(`[QR Lib] jsQR załadowany w ${(performance.now() - t0).toFixed(0)} ms.`);
      res(window.jsQR);
    };
    s.onerror = (err) => {
      console.error("[QR Lib] Błąd ładowania jsQR:", err);
      rej(err);
    };
    document.head.append(s);
  });
  return jsqrPromise;
}
const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
if (detector) {
  console.log("[QR Lib] Wykryto natywny BarcodeDetector w przeglądarce.");
} else {
  console.log("[QR Lib] Brak BarcodeDetector – użyjemy jsQR fallback.");
}

async function decodeCanvas(canvas) {
  if (detector) {
    try {
      const r = await detector.detect(canvas);
      if (r[0]?.rawValue) {
        console.log("[QR Decode] BarcodeDetector wykrył kod:", r[0].rawValue);
        return r[0].rawValue;
      }
    } catch (err) {
      console.warn("[QR Decode] Błąd BarcodeDetector:", err);
    }
  }
  try {
    const jsQR = await loadJsQR();
    const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
    if (code) {
      console.log("[QR Decode] jsQR wykrył kod:", code);
    }
    return code;
  } catch (err) {
    console.warn("[QR Decode] Błąd jsQR:", err);
    return null;
  }
}

/* OCR dla naklejek Lime (wyciąga numer z tabliczki np. DEE-XKY lub RJR-SER) */
let tesseractPromise = null;
function loadTesseract() {
  tesseractPromise ??= new Promise((res, rej) => {
    console.log("[OCR] Pobieranie skryptu Tesseract.js (v5) z CDN...");
    const t0 = performance.now();
    if (window.Tesseract) {
      console.log("[OCR] Tesseract.js już istnieje w oknie.");
      return res(window.Tesseract);
    }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = () => {
      console.log(`[OCR] Skrypt Tesseract.js pobrany w ${(performance.now() - t0).toFixed(0)} ms.`);
      res(window.Tesseract);
    };
    s.onerror = (e) => {
      console.error("[OCR] Błąd pobierania skryptu Tesseract.js:", e);
      rej(e);
    };
    document.head.append(s);
  });
  return tesseractPromise;
}

let ocrWorkerPromise = null;
let ocrWorkerReady = false;

async function getOcrWorker() {
  ocrWorkerPromise ??= (async () => {
    console.log("[OCR Worker] Tworzenie instancji Tesseract WebWorker (język: eng)...");
    const t0 = performance.now();
    const T = await loadTesseract();
    const worker = await T.createWorker("eng", 1, {
      errorHandler: (err) => console.warn("[OCR Worker Error]", err),
      logger: (m) => {
        if (m.status === "loading tesseract core" || m.status === "loading language traineddata" || m.status === "initializing api") {
          console.log(`[OCR Worker Init] ${m.status}: ${Math.round((m.progress || 0) * 100)}%`);
        }
      },
    });
    console.log("[OCR Worker] Ustawianie parametrów (biała lista znaków tabliczki)...");
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-. ",
    });
    ocrWorkerReady = true;
    console.log(`%c[OCR Worker Gotowy] Pełna inicjalizacja zajęła ${(performance.now() - t0).toFixed(0)} ms.`, "color:#10b981; font-weight:bold;");
    return worker;
  })();
  return ocrWorkerPromise;
}

// Pre-warming OCR w tle
async function prewarmOcr() {
  try {
    console.log("[OCR Pre-warm] Start rozgrzewania Tesseract i jsQR w tle...");
    loadJsQR().catch(() => {});
    await getOcrWorker();
    console.log("[OCR Pre-warm] Sukces! Silnik OCR jest rozgrzany i gotowy.");
  } catch (err) {
    console.warn("[OCR Pre-warm] Ostrzeżenie przy rozgrzewaniu OCR w tle:", err);
  }
}
window.prewarmOcr = prewarmOcr;

// Uruchomienie pre-warmingu po załadowaniu strony w wolnym czasie przeglądarki
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => prewarmOcr(), { timeout: 2000 });
} else {
  setTimeout(prewarmOcr, 1000);
}

function parsePlate(text) {
  if (!text) return null;
  console.log("[OCR Parser] Analiza surowego tekstu z OCR:", JSON.stringify(text));
  // Format No.RJR-SER, No. RJR-SER, RJR-SER, RJR SER, DEE-XKY, 338-921
  const m = text.match(/(?:No[.:\s]*)?([A-Z0-9]{3})[-–—\s]([A-Z0-9]{3})/i);
  if (m) {
    const c1 = m[1].toUpperCase(), c2 = m[2].toUpperCase();
    if (!["LIM", "BIK", "HTT", "WWW"].includes(c1) && !["IME", "IKE", "TPS", "COM"].includes(c2)) {
      console.log(`%c[OCR Parser] ZNALEZIONO TABLICZKĘ (3-3): ${c1}-${c2}`, "color:#10b981; font-weight:bold;");
      return `${c1}-${c2}`;
    } else {
      console.log(`[OCR Parser] Odrzucono dopasowanie (blacklist): ${c1}-${c2}`);
    }
  }
  const m6 = text.match(/(?:No[.:\s]*)?([A-Z0-9]{6})/i);
  if (m6) {
    const c = m6[1].toUpperCase();
    if (!["LIMEBI", "LIMEAP", "HTTPS", "HTTP"].includes(c)) {
      const formatted = `${c.slice(0, 3)}-${c.slice(3)}`;
      console.log(`%c[OCR Parser] ZNALEZIONO TABLICZKĘ (6-znaków): ${formatted}`, "color:#10b981; font-weight:bold;");
      return formatted;
    }
  }
  console.log("[OCR Parser] Brak wzorca tabliczki (No.XXX-XXX / XXX-XXX) w tym tekście.");
  return null;
}

window.__lastOcrDebug = null;

function renderOcrDebug() {
  const box = $("ocr-debug-box");
  const content = $("ocr-debug-content");
  if (!box || !content) return;
  const isDebug = localStorage.getItem("debug") === "1" || new URLSearchParams(location.search).has("debug");
  if (!window.__lastOcrDebug) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (isDebug) {
    box.open = true;
  }

  const d = window.__lastOcrDebug;
  content.innerHTML = `
    <div class="space-y-3">
      <div class="flex items-center justify-between text-muted text-[11px]">
        <span>Klatka wejściowa: ${d.width}x${d.height}px</span>
        <span>Łączny czas: ${d.totalDuration} ms</span>
      </div>
      <div>
        <p class="font-medium text-xs mb-1">Złapana klatka z zaznaczonymi paskami skanowania:</p>
        <img src="${d.annotatedFrameUrl}" alt="Klatka OCR" class="w-full rounded border border-default bg-black/40">
      </div>
      <div class="space-y-2">
        <p class="font-medium text-xs">Paski przekazane do Tesseract.js:</p>
        ${d.strips.map((s, i) => `
          <div class="p-2 rounded border border-default bg-card/80 space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-xs" style="color:${s.color}">${i + 1}. ${esc(s.name)} (${s.duration} ms)</span>
              <span class="text-xs ${s.parsedPlate ? 'text-emerald-500 font-bold' : 'text-muted'}">${s.parsedPlate ? '✓ ' + esc(s.parsedPlate) : '✗ brak tabliczki'}</span>
            </div>
            <img src="${s.dataUrl}" alt="${esc(s.name)}" class="w-full rounded border border-default/60 bg-black/30">
            <div class="bg-muted/80 p-1.5 rounded font-mono text-[11px] break-all leading-snug">
              <span class="text-muted block text-[10px]">Rozpoznany tekst Tesseract:</span>
              ${esc(s.rawText || "(pusty wynik)")}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}
window.renderOcrDebug = renderOcrDebug;

async function tryOcrLimePlate(imageSource) {
  if (!imageSource) {
    console.warn("[OCR] Brak źródła obrazu.");
    return null;
  }
  const tStart = performance.now();
  console.log("[OCR] >>> ROZPOCZYNAM ODCZYT TABLICZKI LIME Z OBRAZU <<<");
  try {
    let bmp;
    if (imageSource instanceof Blob) {
      console.log(`[OCR] Tworzenie ImageBitmap z Bloba (rozmiar: ${(imageSource.size / 1024).toFixed(1)} KB, type: ${imageSource.type})...`);
      bmp = await createImageBitmap(imageSource);
    } else if (imageSource instanceof HTMLVideoElement || imageSource instanceof HTMLImageElement || imageSource instanceof HTMLCanvasElement) {
      console.log("[OCR] Tworzenie ImageBitmap z elementu wideo/obrazu...");
      bmp = await createImageBitmap(imageSource);
    }
    if (!bmp) {
      console.warn("[OCR] Nie udało się utworzyć ImageBitmap.");
      return null;
    }

    const maxW = 1000;
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    console.log(`[OCR] Klatka oryginalna: ${bmp.width}x${bmp.height}px -> Przeskalowana do: ${w}x${h}px (scale: ${scale.toFixed(2)})`);

    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = w;
    baseCanvas.height = h;
    const baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true });
    baseCtx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    console.log(`[OCR] Sprawdzam stan workera Tesseract (czy gotowy: ${ocrWorkerReady ? "TAK" : "NIE - czekam na inicjalizację..."})...`);
    const worker = await Promise.race([
      getOcrWorker(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("OCR worker init timeout (8s)")), 8000)),
    ]);

    // Paski do przetestowania (dół pod kodem QR i góra nad kodem QR)
    const strips = [
      { name: "dół_główny (y: 48%-72%)", y: 0.48, h: 0.24, color: "#10b981" },
      { name: "dół_niższy (y: 58%-82%)", y: 0.58, h: 0.24, color: "#3b82f6" },
      { name: "góra (y: 18%-42%)", y: 0.18, h: 0.24, color: "#f59e0b" },
    ];

    // Przygotowanie klatki z adnotacjami (obrysami pasków) do debugowania
    const annotCanvas = document.createElement("canvas");
    annotCanvas.width = w;
    annotCanvas.height = h;
    const annotCtx = annotCanvas.getContext("2d");
    annotCtx.drawImage(baseCanvas, 0, 0);

    const debugStrips = [];
    const stripCanvas = document.createElement("canvas");
    const stripCtx = stripCanvas.getContext("2d", { willReadFrequently: true });

    let detectedPlate = null;

    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      const tStrip = performance.now();
      const sw = Math.floor(w * 0.85);
      const sh = Math.floor(h * s.h);
      const sx = Math.floor(w * 0.075);
      const sy = Math.floor(h * s.y);

      // Rysuj ramkę na klatce poglądowej
      annotCtx.strokeStyle = s.color;
      annotCtx.lineWidth = 3;
      annotCtx.strokeRect(sx, sy, sw, sh);
      annotCtx.fillStyle = s.color;
      annotCtx.font = "bold 14px sans-serif";
      annotCtx.fillText(`${i + 1}. ${s.name}`, sx + 4, Math.max(16, sy - 4));

      stripCanvas.width = sw;
      stripCanvas.height = sh;
      stripCtx.drawImage(baseCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

      const stripDataUrl = stripCanvas.toDataURL("image/jpeg", 0.9);

      console.log(`[OCR] Skanowanie paska ${i + 1}/${strips.length}: ${s.name} [x:${sx}, y:${sy}, ${sw}x${sh}px]...`);
      const res = await Promise.race([
        worker.recognize(stripCanvas),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Pasek ${s.name} timeout (5s)`)), 5000)),
      ]);

      const rawText = res?.data?.text?.trim() || "";
      const stripDuration = Math.round(performance.now() - tStrip);
      console.log(`[OCR] Wynik paska ${i + 1} (${s.name}) w ${stripDuration} ms:`, JSON.stringify(rawText));

      const plate = parsePlate(rawText);
      debugStrips.push({
        name: s.name,
        color: s.color,
        dataUrl: stripDataUrl,
        rawText,
        parsedPlate: plate,
        duration: stripDuration,
      });

      if (plate && !detectedPlate) {
        detectedPlate = plate;
        console.log(`%c[OCR SUKCES] Znaleziono numer ${plate} na pasku ${s.name} (całkowity czas OCR: ${(performance.now() - tStart).toFixed(0)} ms)`, "color:#10b981; font-weight:bold; font-size:13px;");
        break;
      }
    }

    window.__lastOcrDebug = {
      width: w,
      height: h,
      annotatedFrameUrl: annotCanvas.toDataURL("image/jpeg", 0.8),
      strips: debugStrips,
      totalDuration: Math.round(performance.now() - tStart),
      detectedPlate,
    };
    renderOcrDebug();

    return detectedPlate;
  } catch (e) {
    console.error("[OCR BŁĄD / WYJĄTEK]", e);
  }
  console.warn(`[OCR BRAK TABLICZKI] Nie udało się wyodrębnić numeru tabliczki w ${(performance.now() - tStart).toFixed(0)} ms. Używam kodu QR jako fallback.`);
  return null;
}

/* ---------- Krok 1: kod QR skanowany na żywo ---------- */
// Operator, numer i informacja, czy hulajnoga była już dziś zgłoszona (backend)
async function checkCurrent(code, operator, photoSource) {
  console.log("[Check] Rozpoczynam weryfikację:", { code, operator, hasPhotoSource: !!photoSource });
  const mine = current;
  mine.status = "analyzing";
  mine.analyzingMsg = "Sprawdzam kod…";
  renderStart();

  let detectedId = null;
  const isLime = (typeof code === "string" && /li\.me|lime/i.test(code)) || operator === "lime";
  if (isLime && photoSource) {
    console.log("[Check] Wykryto hulajnogę Lime. Próbuję odczytać numer tabliczki OCR...");
    mine.analyzingMsg = "Odczytuję numer z naklejki…";
    renderStart();
    detectedId = await tryOcrLimePlate(photoSource);
    console.log("[Check] Rezultat OCR dla Lime:", detectedId || "(brak - fallback na kod QR)");
  }

  try {
    const payload = { code, operator, id: detectedId || undefined };
    console.log("[Check] Wysyłam żądanie POST /api/check:", payload);
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    console.log("[Check] Odpowiedź serwera /api/check:", d);
    if (current !== mine) return;
    mine.code = d.code;
    mine.id = d.id;
    if (!d.operator) {
      mine.operator = null;
      mine.status = "needop";
    } else {
      mine.operator = d.operator.key;
      mine.operatorName = d.operator.name;
      mine.status = d.duplicate ? "reported" : scooters.some((s) => idKey(s) === idKey(mine)) ? "onlist" : "ok";
    }
  } catch (err) {
    console.error("[Check] Błąd żądania /api/check:", err);
    if (current === mine) mine.status = "error";
  }
  if (current !== mine) return;
  if (mine.status === "ok") {
    openManual(true);
  } else if (mine.status === "needop" || mine.status === "error") {
    openManual(false);
  } else {
    show("start");
    renderStart();
  }
}

function renderStart() {
  const busy = current?.status === "analyzing";
  const fail = current && ["needop", "error"].includes(current.status);
  const blocked = current && ["reported", "onlist"].includes(current.status);
  const thumb = current?.qr ? `<img src="${current.qr.url}" alt="" class="w-16 h-16 rounded-md object-cover bg-muted flex-none">` : "";
  let state = "";
  if (busy) {
    state = `<div class="flex items-center gap-4">${thumb}<p class="text-sm text-muted">${esc(current?.analyzingMsg || "Sprawdzam kod…")}</p></div>`;
  } else if (fail) {
    const msg = current.status === "needop" ? "Nie rozpoznaliśmy operatora tej hulajnogi." : "Nie udało się sprawdzić kodu.";
    state = `<div class="flex items-start gap-4">${thumb}<div class="min-w-0">
        <p class="text-sm font-medium">${msg}</p>
        <p class="text-sm text-muted mt-1 leading-relaxed">Zeskanuj kod jeszcze raz albo wpisz numer ręcznie.</p></div></div>`;
  } else if (blocked) {
    const op = opByKey(current.operator);
    const msg =
      current.status === "reported"
        ? `Hulajnoga ${esc(current.id)} (${esc(op.name)}) była już dziś zgłoszona. Nie przyjmujemy drugiego zgłoszenia tego samego dnia. Zeskanuj kod innej hulajnogi.`
        : `Hulajnoga ${esc(current.id)} jest już na liście. Zeskanuj kod innej hulajnogi.`;
    state = `<div class="flex items-start gap-4 rounded-lg border p-3" style="border-color:hsl(var(--danger))">${thumb}<p class="text-sm text-danger leading-relaxed" role="alert">${msg}</p></div>`;
  }
  $("qr-state").innerHTML = state;

  $("capture").classList.toggle("hidden", busy);
  $("scan-start").textContent = fail || blocked ? "Zeskanuj ponownie" : "Zeskanuj kod QR";
  $("scan-start").disabled = $("manual-start").disabled = quota?.remaining === 0;
}

/* ---------- Zdjęcie 2: dokumentacja ---------- */
function renderDoc() {
  if (!current) return;
  const op = opByKey(current.operator);
  $("doc-chip").innerHTML = `<span class="dot" style="background:${dotColor(op)}"></span><span>Mamy to: ${esc(op?.name || current.operator)}, numer <strong>${esc(current.id)}</strong></span><button id="doc-edit-id" class="ml-auto text-xs text-muted hover:text-[hsl(var(--foreground))] underline flex-none">Zmień</button>`;
  $("doc-edit-id")?.addEventListener("click", () => openManual(true));
  $("doc-thumbs").innerHTML = current.docs.map((d, i) => `<div class="relative"><img src="${d.url}" alt="Zdjęcie ${i + 1}" class="w-full aspect-square rounded-lg object-cover bg-muted"><button data-i="${i}" class="doc-rm absolute top-2 right-2 h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-medium" aria-label="Usuń zdjęcie">Usuń</button></div>`).join("");
  $("doc-thumbs").classList.toggle("hidden", !current.docs.length);
  $("doc-thumbs").querySelectorAll(".doc-rm").forEach((b) =>
    b.addEventListener("click", () => {
      const [d] = current.docs.splice(Number(b.dataset.i), 1);
      freePhotos([d]);
      renderDoc();
    }),
  );
  const n = current.docs.length;
  $("doc-capture").classList.toggle("hidden", n >= MAX_DOCS);
  $("doc-shot").textContent = n ? "Zrób kolejne" : "Zrób zdjęcie";
  $("doc-shot").className = `btn ${n ? "btn-secondary" : "btn-primary"}`;
  $("doc-done").disabled = n === 0;
  $("doc-hint").textContent = n === 0 ? "Dodaj przynajmniej jedno zdjęcie, żeby przejść dalej. Możesz dodać do dwóch." : n < MAX_DOCS ? "Możesz dodać jeszcze jedno zdjęcie albo zakończyć." : "Mamy komplet zdjęć.";
}

async function handleDocFiles(input) {
  const files = [...input.files].slice(0, MAX_DOCS - (current?.docs.length ?? 0));
  input.value = "";
  if (!current) return;
  for (const file of files) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      current.docs.push(await makePhoto(bmp));
      bmp.close?.();
      renderDoc();
    } catch {
      /* nieczytelny plik – pomijamy */
    }
  }
}
$("scan-start").onclick = openScanner;
$("manual-start").onclick = () => {
  discardCurrent();
  openManual();
};
$("doc-shot-in").addEventListener("change", (e) => handleDocFiles(e.target));
$("doc-add-in").addEventListener("change", (e) => handleDocFiles(e.target));
$("doc-shot").onclick = () => $("doc-shot-in").click();
$("doc-add").onclick = () => $("doc-add-in").click();

// Jedna hulajnoga na zgłoszenie: zdjęcia zostają w `current`, żeby dało się wrócić z kroku 3 i je poprawić
async function goToEmail() {
  if (!current || !current.docs.length) return;
  const err = $("err-doc");
  err.classList.add("hidden");
  if (!loc) await locate();
  if (!loc) {
    err.textContent = "Nie udało się ustalić lokalizacji. Włącz GPS i spróbuj ponownie.";
    return err.classList.remove("hidden");
  }
  scooters = [
    {
      uid: ++uid,
      code: current.code,
      operator: current.operator,
      operatorName: current.operatorName,
      id: current.id,
      hasQr: !!current.qr,
      photos: [current.qr, ...current.docs].filter(Boolean),
    },
  ];
  let saved = "";
  try {
    saved = localStorage.getItem(CC_KEY) || "";
  } catch {}
  $("cc").value = saved;
  $("err2").classList.add("hidden");
  show("email");
}
$("doc-done").onclick = goToEmail;
$("doc-back").onclick = () => {
  discardCurrent();
  scooters = [];
  show("start");
  renderStart();
};

/* ---------- Skaner na żywo i wpis ręczny (gdy kodu nie widać na zdjęciu) ---------- */
let stream = null;
let scanning = false;
async function openScanner() {
  console.log("[Scanner] Otwieranie widoku skanera na żywo...");
  prewarmOcr(); // upewniamy się, że OCR i jsQR są rozgrzewane w tle
  if (!loc) locate();
  discardCurrent();
  scooters = [];
  current = { status: "scanning", qr: null, docs: [] };
  const mine = current;
  show("scan");
  const frame = $("scan-frame");
  if (frame) {
    frame.className = "absolute inset-[18%] rounded-lg border-2 border-white/80 pointer-events-none transition-all duration-300";
  }
  $("scan-msg").innerHTML = "Włączam aparat…";
  const tScanStart = performance.now();
  try {
    console.log("[Camera] Żądanie strumienia getUserMedia (environment, ideal 1920)...");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false });
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings() || {};
    console.log(`[Camera] Kamera uruchomiona: ${settings.width || "?"}x${settings.height || "?"} @ ${settings.frameRate || "?"}fps (label: ${track?.label || "kamera"})`);
    const v = $("video");
    v.srcObject = stream;
    await v.play();
    console.log(`[Camera] Odtwarzanie wideo aktywne (${v.videoWidth}x${v.videoHeight}px). Rozpoczynam pętlę detekcji QR.`);
    $("scan-msg").innerHTML = "Szukam kodu QR…";
    scanning = true;
    const c = document.createElement("canvas");
    let frameCount = 0;
    const tick = async () => {
      if (!scanning || current !== mine) return;
      if (v.videoWidth) {
        frameCount++;
        const s = Math.min(1, 720 / v.videoWidth);
        c.width = Math.round(v.videoWidth * s);
        c.height = Math.round(v.videoHeight * s);
        c.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, 0, c.width, c.height);
        
        if (frameCount % 20 === 1) {
          console.log(`[Scanner Loop] Przetwarzam klatkę #${frameCount} (${c.width}x${c.height}px)...`);
        }
        const code = await decodeCanvas(c);
        if (code && scanning && current === mine) {
          console.log(`%c[Scanner QR SUKCES] ZNALEZIONO KOD QR: "${code}" w ${(performance.now() - tScanStart).toFixed(0)} ms (klatka #${frameCount})`, "color:#10b981; font-weight:bold; font-size:13px;");
          scanning = false; // zatrzymaj pętlę detekcji
          navigator.vibrate?.([40, 30, 60]);

          // Zielona ramka z poświatą i komunikat sukcesu
          if (frame) {
            frame.className = "absolute inset-[18%] rounded-lg border-2 border-emerald-400 bg-emerald-500/20 shadow-[0_0_24px_rgba(52,211,153,0.6)] scale-[1.03] pointer-events-none transition-all duration-300 ease-out";
          }
          $("scan-msg").innerHTML = `<span class="text-emerald-500 font-medium">✓ Kod odczytany!</span>`;

          // Zdjęcie kodu QR = klatka z podglądu w chwili odczytu
          console.log("[Scanner] Zapisuję klatkę wideo do zdjęcia QR...");
          mine.qr = await makePhoto(v);

          // Płynna pauza (~800 ms), kamera pozostaje włączona w tle
          console.log("[Scanner] Pauza 800 ms (zielona ramka)...");
          await new Promise((res) => setTimeout(res, 800));

          stopScanner();
          return checkCurrent(code, null, mine.qr.blob);
        }
      }
      setTimeout(tick, 120);
    };
    tick();
  } catch (err) {
    console.error("[Camera BŁĄD] Brak dostępu lub błąd aparatu:", err);
    $("scan-msg").textContent = "Brak dostępu do aparatu. Zezwól na aparat w ustawieniach przeglądarki albo wpisz numer ręcznie.";
  }
}
function stopScanner() {
  console.log("[Scanner] Zatrzymywanie kamery i skanera.");
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
$("scan-cancel").onclick = () => {
  stopScanner();
  discardCurrent();
  show("start");
  renderStart();
};
$("manual").onclick = () => {
  stopScanner();
  openManual();
};
function openManual(isConfirmation = false) {
  if (!current) current = { status: "manual", qr: null, docs: [] };
  $("err-manual")?.classList.add("hidden");

  const hasQr = !!current.qr;
  const thumbWrap = $("m-thumb-wrap");
  if (thumbWrap) {
    thumbWrap.classList.toggle("hidden", !hasQr);
    if (hasQr) $("m-thumb").src = current.qr.url;
  }

  if (isConfirmation || hasQr) {
    $("m-title").textContent = "Potwierdź dane hulajnogi";
    $("m-desc").textContent = "Odczytaliśmy operatora i numer. Sprawdź, czy numer zgadza się z tabliczką, lub popraw go.";
  } else {
    $("m-title").textContent = "Wpisz numer ręcznie";
    $("m-desc").textContent = "Wybierz operatora i wpisz numer z kierownicy lub tabliczki hulajnogi.";
  }

  if (current.operator) $("m-op").value = current.operator;
  $("m-id").value = current.id || (current.code ? current.code : "");
  renderOcrDebug();
  show("manual");
  $("m-id").focus();
}
$("m-back").onclick = () => {
  discardCurrent();
  show("start");
  renderStart();
};
$("m-ok").onclick = async () => {
  const enteredId = $("m-id").value.trim();
  const opKey = $("m-op").value;
  const err = $("err-manual");
  err?.classList.add("hidden");

  if (!enteredId) {
    if (err) {
      err.textContent = "Wpisz numer hulajnogi.";
      err.classList.remove("hidden");
    }
    return $("m-id").focus();
  }
  if (!opKey) {
    if (err) {
      err.textContent = "Wybierz operatora.";
      err.classList.remove("hidden");
    }
    return;
  }

  if (!current) current = { status: "ok", qr: null, docs: [] };
  current.id = enteredId;
  current.operator = opKey;
  current.operatorName = opByKey(opKey)?.name || opKey;
  current.code = current.code || enteredId;

  // Sprawdź duplikat na backendzie
  try {
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: current.code, operator: opKey, id: enteredId }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.duplicate) {
        if (err) {
          err.textContent = `Hulajnoga ${enteredId} (${current.operatorName}) była już dziś zgłoszona. Nie przyjmujemy drugiego zgłoszenia tego samego dnia.`;
          err.classList.remove("hidden");
        }
        return;
      }
    }
  } catch {}

  current.status = "ok";
  show("doc");
  renderDoc();
};

/* ---------- Krok 3: kopia (e-mail zapamiętany lokalnie) ---------- */
$("next2").onclick = () => {
  const v = $("cc").value.trim();
  const err = $("err2");
  if (v && !EMAIL_RE.test(v)) {
    err.textContent = "To nie wygląda na adres e-mail. Popraw go albo wybierz „Pomiń”.";
    return err.classList.remove("hidden");
  }
  cc = v;
  try {
    v ? localStorage.setItem(CC_KEY, v) : localStorage.removeItem(CC_KEY);
  } catch {}
  openConfirm();
};
$("skip2").onclick = () => {
  cc = "";
  openConfirm();
};
$("back2").onclick = () => {
  if (current) {
    show("doc");
    renderDoc();
  } else {
    show("start");
    renderStart();
  }
};

/* ---------- Krok 3: podgląd i wysyłka ---------- */
function highlight(text, tokens) {
  const t = [...new Set(tokens.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!t.length) return esc(text);
  const re = new RegExp("(" + t.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");
  return text.split(re).map((part, i) => (i % 2 ? `<span class="badge">${esc(part)}</span>` : esc(part))).join("");
}

function renderMails(data) {
  whenIso = data.whenIso;
  $("mails").innerHTML = "";
  for (const m of data.messages) {
    const photos = scooters.filter((s) => s.operator === m.operator).flatMap((s) => s.photos);
    const h = m.highlights;
    const el = document.createElement("div");
    el.className = "mail";
    el.innerHTML = `
      <div class="mail-row"><span>Od</span><span>${esc(m.from)}</span></div>
      <div class="mail-row"><span>Do</span><span><span class="badge">${esc(m.to)}</span></span></div>
      ${m.cc ? `<div class="mail-row"><span>DW</span><span><span class="badge">${esc(m.cc)}</span></span></div>` : ""}
      <div class="mail-row"><span>Temat</span><span>${highlight(m.subject, [...h.ids, h.street])}</span></div>
      <div class="mail-body">${highlight(m.body, [...h.ids, h.address, h.when])}</div>
      <div class="mail-att"><span>Załączniki:</span>${photos.map((p) => `<img src="${p.url}" alt="">`).join("")}<span>${photosWord(photos.length)}</span></div>`;
    $("mails").append(el);
  }
}

function updateSend() {
  $("send").disabled = !tsToken;
}

async function openConfirm() {
  const err = $("err3");
  err.classList.add("hidden");
  $("mails").innerHTML = `<p class="text-sm text-muted">Przygotowuję wiadomość…</p>`;
  show("confirm");
  updateSend();
  try {
    const r = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat: loc.lat, lng: loc.lng, cc, scooters: scooters.map((s) => ({ code: s.code, operator: s.operator, hasQr: s.hasQr })) }),
    });
    const d = await r.json();
    if (r.status === 409) {
      $("mails").innerHTML = "";
      return showErr3(duplicateMessage(d));
    }
    if (r.status === 429) {
      setQuota(d.quota);
      $("mails").innerHTML = "";
      return showErr3(quotaMessage(d));
    }
    if (!r.ok) throw new Error(d.error || "error");
    setQuota(d.quota);
    renderMails(d);
  } catch (e) {
    $("mails").innerHTML = "";
    showErr3(e.message === "outside_warsaw" ? "Zgłoszenia przyjmujemy tylko z Warszawy." : "Nie udało się przygotować wiadomości. Wróć i spróbuj ponownie.");
  }
  if (!tsWidget && window.turnstile) {
    tsWidget = turnstile.render("#ts", {
      sitekey: config.turnstileSiteKey,
      callback: (t) => {
        tsToken = t;
        updateSend();
      },
      "expired-callback": () => {
        tsToken = "";
        updateSend();
      },
    });
  }
}
function showErr3(m) {
  $("err3").textContent = m;
  $("err3").classList.remove("hidden");
}
$("back3").onclick = () => show("email");

$("send").onclick = async () => {
  const btn = $("send");
  $("err3").classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Wysyłanie…";

  const fd = new FormData();
  fd.set("turnstile", tsToken);
  fd.set("lat", loc.lat);
  fd.set("lng", loc.lng);
  fd.set("cc", cc);
  if (whenIso) fd.set("whenIso", whenIso);
  fd.set("scooters", JSON.stringify(scooters.map((s) => ({ code: s.code, operator: s.operator, hasQr: s.hasQr }))));
  // photo{i}_0 = kod QR (gdy hasQr), dalej dokumentacja
  scooters.forEach((s, i) => s.photos.forEach((p, j) => fd.set(`photo${i}_${j}`, p.blob, `photo${i}_${j}.jpg`)));

  try {
    const res = await fetch("/api/report", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) return showErr3(duplicateMessage(data));
    if (res.status === 429) {
      setQuota(data.quota);
      return showErr3(quotaMessage(data));
    }
    if (data.results) return finish(data);
    throw new Error(data.error || "error");
  } catch (e) {
    const msgs = {
      turnstile_failed: "Weryfikacja anty-spam nie powiodła się. Potwierdź ją ponownie.",
      outside_warsaw: "Zgłoszenia przyjmujemy tylko z Warszawy.",
      too_large: "Zdjęcia są za duże.",
      need_photos: "Do każdej hulajnogi potrzebne jest zdjęcie kodu QR i zdjęcie miejsca, w którym stoi (przy ręcznie wpisanym numerze wystarczy to drugie).",
      bad_cc: "Adres e-mail w DW jest niepoprawny. Wróć i popraw go.",
    };
    showErr3(msgs[e.message] || "Coś poszło nie tak. Spróbuj ponownie.");
  } finally {
    btn.textContent = "Wygląda ok, wysyłamy!";
    if (window.turnstile && tsWidget !== null) {
      turnstile.reset(tsWidget);
      tsToken = "";
    }
    updateSend();
  }
};

function finish(data) {
  const sent = data.results.filter((r) => r.status === "sent");
  const failed = data.results.filter((r) => r.status === "failed");
  const sentKeys = new Set(sent.map((r) => r.operator));
  scooters.filter((s) => sentKeys.has(s.operator)).forEach((s) => freePhotos(s.photos));
  scooters = scooters.filter((s) => !sentKeys.has(s.operator));
  if (!scooters.length) current = null;

  if (failed.length && scooters.length) {
    // Część poszła, część nie – zostajemy na potwierdzeniu tylko z tym, co się nie wysłało
    showErr3(`Nie udało się wysłać do: ${failed.map((f) => f.name).join(", ")}. Spróbuj ponownie.`);
    return openConfirm();
  }
  setQuota(data.quota);
  show("done");
}

$("again").onclick = () => {
  scooters.forEach((s) => freePhotos(s.photos));
  scooters = [];
  discardCurrent();
  renderStart();
  show("start");
};

/* Turnstile (explicit render) */
const ts = document.createElement("script");
ts.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
ts.async = true;
document.head.append(ts);

renderStart();
show("start");
locate();
refreshQuota();
