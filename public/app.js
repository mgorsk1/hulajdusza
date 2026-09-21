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
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        loc = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), street: null };
        resolve(loc);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  }).then((l) => {
    renderLoc();
    if (l) resolveStreet(l);
    return l;
  });
}
async function resolveStreet(l) {
  try {
    const r = await fetch(`/api/geocode?lat=${l.lat}&lng=${l.lng}`);
    const d = await r.json();
    l.street = r.ok ? d.street || "" : r.status === 422 ? "poza Warszawą" : "";
  } catch {
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

/* Odczyt QR w przeglądarce: BarcodeDetector albo jsQR z CDN */
let jsqrPromise;
function loadJsQR() {
  jsqrPromise ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
    s.onload = () => res(window.jsQR);
    s.onerror = rej;
    document.head.append(s);
  });
  return jsqrPromise;
}
const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
async function decodeCanvas(canvas) {
  if (detector) {
    try {
      const r = await detector.detect(canvas);
      if (r[0]?.rawValue) return r[0].rawValue;
    } catch {}
  }
  try {
    const jsQR = await loadJsQR();
    const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
  } catch {
    return null;
  }
}

/* OCR dla naklejek Lime (wyciąga numer z tabliczki np. DEE-XKY lub 338-921) */
let tesseractPromise;
function loadTesseract() {
  tesseractPromise ??= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = () => res(window.Tesseract);
    s.onerror = rej;
    document.head.append(s);
  });
  return tesseractPromise;
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  ocrWorkerPromise ??= (async () => {
    const T = await loadTesseract();
    const worker = await T.createWorker("eng", 1, {
      errorHandler: (err) => console.warn("Tesseract worker error:", err),
    });
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ",
    });
    return worker;
  })();
  return ocrWorkerPromise;
}

async function tryOcrLimePlate(imageSource) {
  if (!imageSource) return null;
  try {
    const worker = await Promise.race([
      getOcrWorker(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ocr_timeout")), 4000)),
    ]);
    const { data: { text } } = await Promise.race([
      worker.recognize(imageSource),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ocr_timeout")), 5000)),
    ]);
    if (!text) return null;

    // Szukamy formatu 3 znaki - 3 znaki (np. DEE-XKY lub 338-921)
    const fullMatch = text.match(/\b([A-Z0-9]{3})[-–—]([A-Z0-9]{3})\b/i);
    if (fullMatch) {
      const cand = `${fullMatch[1]}-${fullMatch[2]}`.toUpperCase();
      if (!cand.includes("LIME") && !cand.includes("HTTP")) return cand;
    }

    // Szukamy dwóch słów po 3 znaki (np. "DEE XKY")
    const words = text.replace(/[^A-Za-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) {
      const w1 = words[i].toUpperCase(), w2 = words[i + 1].toUpperCase();
      if (w1.length === 3 && w2.length === 3 && /^[A-Z0-9]{3}$/.test(w1) && /^[A-Z0-9]{3}$/.test(w2)) {
        if (!["LIM", "BIK", "HTT", "WWW", "APP"].includes(w1) && !["IME", "IKE", "TPS", "COM"].includes(w2)) {
          return `${w1}-${w2}`;
        }
      }
    }

    // Ciąg 6 znaków (np. DEEXKY)
    const sixMatch = text.match(/\b([A-Z0-9]{6})\b/i);
    if (sixMatch) {
      const c = sixMatch[1].toUpperCase();
      if (!["LIMEBI", "LIMEAP", "HTTPS", "HTTP"].includes(c)) {
        return `${c.slice(0, 3)}-${c.slice(3)}`;
      }
    }
  } catch (e) {
    console.warn("OCR fallback na kod z QR:", e);
  }
  return null;
}

/* ---------- Krok 1: kod QR skanowany na żywo ---------- */
// Operator, numer i informacja, czy hulajnoga była już dziś zgłoszona (backend)
async function checkCurrent(code, operator, photoSource) {
  const mine = current;
  mine.status = "analyzing";
  mine.analyzingMsg = "Sprawdzam kod…";
  renderStart();

  let detectedId = null;
  const isLime = (typeof code === "string" && /li\.me|lime/i.test(code)) || operator === "lime";
  if (isLime && photoSource) {
    mine.analyzingMsg = "Odczytuję numer z naklejki…";
    renderStart();
    detectedId = await tryOcrLimePlate(photoSource);
  }

  try {
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, operator, id: detectedId || undefined }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
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
  } catch {
    if (current === mine) mine.status = "error";
  }
  if (current !== mine) return;
  if (mine.status === "ok") {
    show("doc");
    renderDoc();
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
  $("doc-chip").innerHTML = `<span class="dot" style="background:${dotColor(op)}"></span>Mamy to: ${esc(op.name)}, numer ${esc(current.id)}`;
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
  if (!loc) locate();
  discardCurrent();
  scooters = [];
  current = { status: "scanning", qr: null, docs: [] };
  const mine = current;
  show("scan");
  $("scan-msg").textContent = "Włączam aparat…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false });
    const v = $("video");
    v.srcObject = stream;
    await v.play();
    $("scan-msg").textContent = "Szukam kodu QR…";
    scanning = true;
    const c = document.createElement("canvas");
    const tick = async () => {
      if (!scanning || current !== mine) return;
      if (v.videoWidth) {
        const s = Math.min(1, 720 / v.videoWidth);
        c.width = v.videoWidth * s;
        c.height = v.videoHeight * s;
        c.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, 0, c.width, c.height);
        const code = await decodeCanvas(c);
        if (code && scanning && current === mine) {
          navigator.vibrate?.(60);
          // Zdjęcie kodu QR = klatka z podglądu w chwili odczytu
          mine.qr = await makePhoto(v);
          stopScanner();
          return checkCurrent(code, null, mine.qr.blob);
        }
      }
      setTimeout(tick, 120);
    };
    tick();
  } catch {
    $("scan-msg").textContent = "Brak dostępu do aparatu. Zezwól na aparat w ustawieniach przeglądarki albo wpisz numer ręcznie.";
  }
}
function stopScanner() {
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
function openManual() {
  if (!current) current = { status: "manual", qr: null, docs: [] };
  if (current.operator) $("m-op").value = current.operator;
  $("m-id").value = current.code ?? "";
  show("manual");
}
$("m-back").onclick = () => {
  discardCurrent();
  show("start");
  renderStart();
};
$("m-ok").onclick = () => {
  const code = $("m-id").value.trim();
  if (!code) return $("m-id").focus();
  if (!current) current = { status: "manual", qr: null, docs: [] };
  show("start");
  checkCurrent(code, $("m-op").value);
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
