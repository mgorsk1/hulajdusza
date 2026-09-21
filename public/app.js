const $ = (id) => document.getElementById(id);
const views = ["start", "scan", "manual", "review", "done"];
const show = (name) => views.forEach((v) => $("v-" + v).classList.toggle("hidden", v !== name));

const MAX_SCOOTERS = 5;
let config = { operators: [], turnstileSiteKey: "" };
let scooters = []; // { blob, url, code, operator, id }
let pendingBlob = null;
let loc = null; // { lat, lng, accuracy }
let tsToken = "";
let tsWidget = null;

const configReady = fetch("/api/config").then((r) => r.json()).then((c) => {
  config = c;
  config.operators.forEach((o) => (o.re = new RegExp(o.match, "i")));
  $("m-op").innerHTML = c.operators.map((o) => `<option value="${o.key}">${o.name}</option>`).join("");
});

const detectOperator = (code) => config.operators.find((o) => o.re.test(code));
const opByKey = (k) => config.operators.find((o) => o.key === k);

function extractId(code) {
  const raw = code.trim();
  try {
    const u = new URL(raw);
    for (const p of ["id", "vehicle", "vehicle_id", "vehicleId", "code", "qr", "v"]) {
      if (u.searchParams.get(p)) return u.searchParams.get(p);
    }
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
  } catch {}
  return raw;
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
  const t = loc
    ? `Lokalizacja: ${where} · ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} (±${loc.accuracy} m)`
    : "Brak lokalizacji – zezwól na dostęp do GPS (dotknij, by spróbować ponownie).";
  $("loc-start").textContent = t;
  $("loc-review").textContent = t;
}

/* ---------- Zdjęcie ---------- */
async function loadBitmap(file) {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}
function drawScaled(bmp, max) {
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.72));

/* ---------- Dekodowanie QR ---------- */
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
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
  } catch {
    return null;
  }
}

/* ---------- Flow ---------- */
function startCapture() {
  if (scooters.length >= MAX_SCOOTERS) return;
  $("cam").value = "";
  $("cam").click();
}

$("cam").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bmp = await loadBitmap(file);
  pendingBlob = await toBlob(drawScaled(bmp, 1280));
  if (!loc) locate();
  // Szybka ścieżka: kod QR bywa widoczny już na zdjęciu
  await configReady;
  const code = await decodeCanvas(drawScaled(bmp, 1600));
  bmp.close?.();
  if (code) return accept(code);
  openScanner();
});

async function accept(code, operatorKey) {
  await configReady;
  const op = detectOperator(code) ?? opByKey(operatorKey);
  if (!op) {
    // Nierozpoznany dostawca – poproś o wybór
    $("m-id").value = code;
    return openManual();
  }
  scooters.push({ blob: pendingBlob, url: URL.createObjectURL(pendingBlob), code, operator: op.key, id: extractId(code) });
  pendingBlob = null;
  openReview();
}

/* Skaner na żywo */
let stream = null;
let scanning = false;
async function openScanner() {
  show("scan");
  $("scan-msg").textContent = "";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    const v = $("video");
    v.srcObject = stream;
    await v.play();
    scanning = true;
    const c = document.createElement("canvas");
    const tick = async () => {
      if (!scanning) return;
      if (v.videoWidth) {
        const s = Math.min(1, 720 / v.videoWidth);
        c.width = v.videoWidth * s;
        c.height = v.videoHeight * s;
        c.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, 0, c.width, c.height);
        const code = await decodeCanvas(c);
        if (code && scanning) {
          navigator.vibrate?.(60);
          stopScanner();
          return accept(code);
        }
      }
      setTimeout(tick, 120);
    };
    tick();
  } catch {
    $("scan-msg").textContent = "Brak dostępu do aparatu. Wpisz dane ręcznie.";
  }
}
function stopScanner() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
$("scan-cancel").onclick = () => {
  stopScanner();
  pendingBlob = null;
  scooters.length ? openReview() : show("start");
};
$("manual").onclick = () => {
  stopScanner();
  openManual();
};

function openManual() {
  show("manual");
}
$("m-back").onclick = openScanner;
$("m-ok").onclick = () => {
  const id = $("m-id").value.trim();
  if (!id) return $("m-id").focus();
  accept(id, $("m-op").value);
};

/* ---------- Podsumowanie i wysyłka ---------- */
function openReview() {
  show("review");
  renderList();
  renderLoc();
  $("err").classList.add("hidden");
  $("add").classList.toggle("hidden", scooters.length >= MAX_SCOOTERS);
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
  updateSend();
}
function renderList() {
  $("list").innerHTML = "";
  scooters.forEach((s, i) => {
    const op = opByKey(s.operator);
    const li = document.createElement("li");
    li.className = "flex items-center gap-4 p-3 rounded-lg border border-default bg-card";
    li.innerHTML = `
      <img src="${s.url}" alt="" class="w-16 h-16 rounded-md object-cover bg-muted flex-none">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 text-sm font-semibold"><span class="dot" style="background:${isDark() ? op.dark : op.color}"></span>${op.name}</div>
        <div class="text-sm text-muted truncate"></div>
      </div>
      <button class="rm text-sm text-muted px-2 h-11" aria-label="Usuń">Usuń</button>`;
    li.querySelector(".truncate").textContent = "#" + s.id;
    li.querySelector(".rm").onclick = () => {
      scooters.splice(i, 1);
      scooters.length ? openReview() : show("start");
    };
    $("list").append(li);
  });
}
function updateSend() {
  $("send").disabled = !(tsToken && scooters.length);
}
$("add").onclick = startCapture;
$("start").onclick = startCapture;
$("loc-review").onclick = $("loc-start").onclick = () => locate();

$("send").onclick = async () => {
  const btn = $("send");
  const err = $("err");
  err.classList.add("hidden");
  if (!loc) await locate();
  if (!loc) return showErr("Nie udało się ustalić lokalizacji. Włącz GPS i spróbuj ponownie.");
  btn.disabled = true;
  btn.textContent = "Wysyłanie…";

  const fd = new FormData();
  fd.set("turnstile", tsToken);
  fd.set("lat", loc.lat);
  fd.set("lng", loc.lng);
  fd.set("scooters", JSON.stringify(scooters.map((s) => ({ operator: s.operator, code: s.code }))));
  scooters.forEach((s, i) => fd.set(`photo${i}`, s.blob, `photo${i}.jpg`));

  try {
    const res = await fetch("/api/report", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "error");
    const n = scooters.length;
    $("done-msg").textContent = `Zgłoszono ${n} ${n === 1 ? "hulajnogę" : "hulajnogi"} (${data.street}). Operator dostał wiadomość ze zdjęciami.`;
    scooters.forEach((s) => URL.revokeObjectURL(s.url));
    scooters = [];
    show("done");
  } catch (e) {
    const msgs = {
      turnstile_failed: "Weryfikacja anty-spam nie powiodła się. Spróbuj ponownie.",
      outside_warsaw: "Zgłoszenia przyjmujemy tylko z Warszawy.",
      too_large: "Zdjęcia są za duże.",
      email_failed: "Nie udało się wysłać maila do operatora.",
    };
    showErr(msgs[e.message] || "Coś poszło nie tak. Spróbuj ponownie.");
  } finally {
    btn.textContent = "Wyślij zgłoszenie";
    if (window.turnstile && tsWidget !== null) {
      turnstile.reset(tsWidget);
      tsToken = "";
    }
    updateSend();
  }
  function showErr(m) {
    err.textContent = m;
    err.classList.remove("hidden");
  }
};

$("again").onclick = () => show("start");

/* Turnstile (explicit render) */
window.onTurnstileLoad = () => {};
const ts = document.createElement("script");
ts.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
ts.async = true;
document.head.append(ts);

locate();
