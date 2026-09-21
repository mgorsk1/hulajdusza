import { OPERATORS, detectOperator, extractScooterId, operatorByKey } from "./operators";
import { sendMail, toBase64, type Attachment, type EmailBinding } from "./mail";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EMAIL: EmailBinding;
  FROM_EMAIL: string;
  EMAIL_DRY_RUN?: string;
  MAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  /** Sekret do HMAC skrótów hulajnóg (blokada powtórzeń). Gdy brak, używany jest TURNSTILE_SECRET. */
  HASH_SECRET?: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  /** Sekundy cache dla /api/stats (0 = wyłączony, np. lokalnie). */
  STATS_CACHE_TTL?: string;
  /** Limity zgłoszeń (1 zgłoszenie = 1 mail do operatora). */
  DAILY_LIMIT?: string;
  MONTHLY_LIMIT?: string;
}

interface ScooterInput {
  operator: string;
  code: string;
  /** Czy pierwsze zdjęcie to zdjęcie kodu QR (przy wpisie ręcznym go nie ma). */
  hasQr?: boolean;
}

const MAX_SCOOTERS = 1; // jedno zgłoszenie dotyczy jednej hulajnogi
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
// Kod QR + co najmniej jedno zdjęcie dokumentujące złe parkowanie. Przy numerze wpisanym ręcznie (hasQr=false)
// nie ma zdjęcia kodu QR, więc wystarcza jedno zdjęcie dokumentujące.
const minPhotos = (hasQr: boolean | undefined) => (hasQr === false ? 1 : 2);
const MAX_PHOTOS = 3; // kod QR + do dwóch zdjęć dokumentujących
// Limit wiadomości w Email Service to 5 MiB, a base64 puchnie o ~33%: na jednego operatora max 3 MB zdjęć
const MAX_GROUP_BYTES = 3 * 1024 * 1024;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
// Warszawa (z zapasem) – zgłoszenia spoza są odrzucane
const WARSAW = { minLat: 52.0, maxLat: 52.4, minLng: 20.75, maxLng: 21.35 };

const inWarsaw = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= WARSAW.minLat && lat <= WARSAW.maxLat && lng >= WARSAW.minLng && lng <= WARSAW.maxLng;

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/config" && request.method === "GET") {
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, operators: OPERATORS }, 200, {
        "cache-control": "public, max-age=60",
      });
    }
    if (pathname === "/api/geocode" && request.method === "GET") return geocode(new URL(request.url));
    if (pathname === "/api/reports" && request.method === "GET") return listReports(env);
    if (pathname === "/api/stats" && request.method === "GET") return cachedStats(request, env, ctx);
    if (pathname === "/api/quota" && request.method === "GET") return json(await quotaState(env), 200, { "cache-control": "no-store" });
    if (pathname === "/api/check" && request.method === "POST") return check(request, env);
    if (pathname === "/api/preview" && request.method === "POST") return preview(request, env);
    if (pathname === "/api/report" && request.method === "POST") return createReport(request, env);
    if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Quota {
  daily: { used: number; limit: number; remaining: number };
  monthly: { used: number; limit: number; remaining: number };
  /** Ile zgłoszeń można jeszcze złożyć: mniejsza z dwóch pul. */
  remaining: number;
  /** Która pula jest ograniczeniem. */
  limitedBy: "daily" | "monthly" | null;
}

const limitOf = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const periodKeys = () => {
  const iso = new Date().toISOString();
  return { d: `d:${iso.slice(0, 10)}`, m: `m:${iso.slice(0, 7)}` };
};

/** Zużycie limitów (UTC – tak jak dobowe limity dostawców poczty). Dwa proste odczyty po kluczu głównym. */
async function quotaState(env: Env): Promise<Quota> {
  const { d, m } = periodKeys();
  const { results } = await env.DB.prepare("SELECT period, used FROM quota_usage WHERE period IN (?, ?)").bind(d, m).all();
  const used = Object.fromEntries((results as { period: string; used: number }[]).map((r) => [r.period, r.used]));
  const dl = limitOf(env.DAILY_LIMIT, 100);
  const ml = limitOf(env.MONTHLY_LIMIT, 3000);
  const daily = { used: used[d] ?? 0, limit: dl, remaining: Math.max(0, dl - (used[d] ?? 0)) };
  const monthly = { used: used[m] ?? 0, limit: ml, remaining: Math.max(0, ml - (used[m] ?? 0)) };
  const remaining = Math.min(daily.remaining, monthly.remaining);
  return { daily, monthly, remaining, limitedBy: daily.remaining <= monthly.remaining ? "daily" : "monthly" };
}

const bumpQuota = (env: Env, n: number) => {
  const { d, m } = periodKeys();
  const up = "INSERT INTO quota_usage (period, used) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET used = MAX(used + excluded.used, 0)";
  const cutoff = new Date(Date.now() - 40 * 86400000).toISOString();
  return env.DB.batch([
    env.DB.prepare(up).bind(d, n),
    env.DB.prepare(up).bind(m, n),
    env.DB.prepare("DELETE FROM quota_usage WHERE period LIKE 'd:%' AND period < ?").bind(`d:${cutoff.slice(0, 10)}`),
  ]);
};

/** Rezerwacja n zgłoszeń. Podbija liczniki, a przy przekroczeniu (np. wyścig równoległych żądań) cofa. */
async function reserveQuota(env: Env, n: number): Promise<{ ok: true; quota: Quota } | { ok: false; error: string; quota: Quota }> {
  const before = await quotaState(env);
  const over = (q: Quota) => (q.daily.used > q.daily.limit ? "quota_daily" : q.monthly.used > q.monthly.limit ? "quota_monthly" : null);
  if (before.remaining < n) return { ok: false, error: before.daily.remaining < n ? "quota_daily" : "quota_monthly", quota: before };
  await bumpQuota(env, n);
  const after = await quotaState(env);
  const err = over(after);
  if (err) {
    await bumpQuota(env, -n);
    return { ok: false, error: err, quota: await quotaState(env) };
  }
  return { ok: true, quota: after };
}

/** Doba wg czasu Warszawy: hulajnoga zgłoszona danego dnia nie może być zgłoszona ponownie. */
const warsawDay = () => new Date(Date.now() + warsawOffsetHours() * 3600000).toISOString().slice(0, 10);

const normalizeId = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Klucz hulajnogi na dany dzień: HMAC-SHA-256 z sekretnym kluczem (HASH_SECRET), więc bez klucza nie da się go
 * odtworzyć ani odwrócić zgadywaniem numerów (przestrzeń numerów jest mała). Dzień jest częścią wiadomości,
 * więc ta sama hulajnoga ma każdego dnia inny skrót, a w bazie nie ma surowego numeru.
 */
async function scooterKey(env: Env, operator: string, id: string): Promise<string> {
  const day = warsawDay();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.HASH_SECRET || env.TURNSTILE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${day}|${operator}|${normalizeId(id)}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${day}:${hex}`;
}

/** Zwraca hulajnogi (operator + numer), które zostały już dziś zgłoszone. */
async function alreadyReported(env: Env, scooters: { operator: string; id: string }[]) {
  if (!scooters.length) return [];
  const keys = await Promise.all(scooters.map((s) => scooterKey(env, s.operator, s.id)));
  const { results } = await env.DB.prepare(`SELECT key FROM reported_scooters WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all();
  const hit = new Set((results as { key: string }[]).map((r) => r.key));
  return scooters.filter((_, i) => hit.has(keys[i]));
}

async function geocode(url: URL): Promise<Response> {
  // Zaokrąglenie zwiększa trafność cache i nie zdradza dokładnej pozycji dalej niż to konieczne
  const lat = Number(Number(url.searchParams.get("lat")).toFixed(4));
  const lng = Number(Number(url.searchParams.get("lng")).toFixed(4));
  if (!inWarsaw(lat, lng)) return json({ error: "outside_warsaw" }, 422);
  return json(await reverseGeocode(lat, lng), 200, { "cache-control": "public, max-age=3600" });
}

async function listReports(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, street, lat, lng, operator, scooter_count FROM reports ORDER BY created_at DESC LIMIT 5000",
  ).all();
  return json(results, 200, { "cache-control": "public, max-age=60" });
}

/** Przesunięcie Europe/Warsaw względem UTC w godzinach (uwzględnia DST). */
function warsawOffsetHours(): number {
  const now = new Date();
  const w = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
  const u = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((w.getTime() - u.getTime()) / 3600000);
}

/**
 * Warstwy: (1) agregaty w D1 – odczyt to kilkadziesiąt wierszy, (2) Cache API na krawędzi – D1 dostaje ≤ 1 zapytanie
 * na TTL na lokalizację, (3) cache przeglądarki. TTL=0 wyłącza cache (lokalny dev).
 */
async function cachedStats(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ttl = Number(env.STATS_CACHE_TTL ?? 60);
  if (!ttl) {
    const res = await stats(env);
    res.headers.set("cache-control", "no-store");
    return res;
  }
  const key = new Request(new URL("/api/stats", request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await stats(env);
  res.headers.set("cache-control", `public, max-age=${ttl}`);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function stats(env: Env): Promise<Response> {
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const H = 3600000;
  const off = warsawOffsetHours();
  const sign = off >= 0 ? "+" : "-";
  const shift = `${sign}${Math.abs(off)} hours`;

  // Jedyna miara: liczba hulajnóg. Czytamy WYŁĄCZNIE agregaty (stats_hourly, stats_totals) – nigdy tabelę reports.
  const hourKey = (msAgo: number) => iso(msAgo).slice(0, 13);
  const cur = hourKey(23 * H); // 24 kubełki godzinowe wliczając bieżący
  const [last24h, byOperator, byDistrict, daily] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN hour >= ?1 THEN scooters END),0) AS scooters,
              COALESCE(SUM(CASE WHEN hour < ?1 THEN scooters END),0) AS previous
       FROM stats_hourly WHERE hour >= ?2`,
    ).bind(cur, hourKey(47 * H)),
    env.DB.prepare("SELECT key AS operator, scooters FROM stats_totals WHERE kind = 'operator' ORDER BY scooters DESC"),
    env.DB.prepare("SELECT key AS district, scooters FROM stats_totals WHERE kind = 'district' ORDER BY scooters DESC"),
    env.DB.prepare(
      `SELECT substr(datetime(hour || ':00:00', ?1), 1, 10) AS day, SUM(scooters) AS scooters
       FROM stats_hourly WHERE hour >= ?2 GROUP BY day ORDER BY day`,
    ).bind(shift, hourKey(32 * 24 * H)),
  ]);

  const today = new Date(now + off * H).toISOString().slice(0, 10);
  return json(
    {
      last24h: last24h.results[0] as { scooters: number; previous: number },
      byOperator: byOperator.results,
      byDistrict: byDistrict.results,
      daily: daily.results,
      today,
    },
    200,
  );
}

async function verifyTurnstile(token: string, ip: string | null, env: Env): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

interface Geo {
  street: string;
  district: string;
}

async function reverseGeocode(lat: number, lng: number): Promise<Geo> {
  const none = { street: "", district: "" };
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=pl&lat=${lat}&lon=${lng}`,
      { headers: { "User-Agent": "hulajdusza/1.0 (zgloszenia zle zaparkowanych hulajnog)" }, cf: { cacheTtl: 86400 } },
    );
    if (!res.ok) return none;
    const data = (await res.json()) as { address?: Record<string, string> };
    const a = data.address ?? {};
    const road = a.road ?? a.pedestrian ?? a.footway ?? a.cycleway ?? a.square ?? a.neighbourhood ?? "";
    const district = (a.city_district ?? a.suburb ?? "").replace(/^dzielnica\s+/i, "").trim();
    return { street: [road, a.house_number].filter(Boolean).join(" ").trim(), district };
  } catch {
    return none;
  }
}

const clean = (s: unknown, max = 200) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

const publicOperator = (key: string) => {
  const op = operatorByKey(key);
  return op ? { key: op.key, name: op.name, email: op.email } : null;
};

/**
 * Sprawdzenie odczytanego (w przeglądarce) kodu QR: operator, numer hulajnogi i informacja, czy ta hulajnoga
 * była już dziś zgłoszona. Nic nie zapisuje.
 */
async function check(request: Request, env: Env): Promise<Response> {
  let input: { code?: unknown; operator?: unknown };
  try {
    input = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const code = clean(input.code, 500);
  if (!code) return json({ error: "bad_code" }, 400);

  const op = detectOperator(code) ?? operatorByKey(clean(input.operator, 20));
  const id = clean(extractScooterId(code), 100);
  const duplicate = op ? (await alreadyReported(env, [{ operator: op.key, id }])).length > 0 : false;
  return json({ code, operator: op ? publicOperator(op.key) : null, id, duplicate });
}

interface DraftInput {
  lat: number;
  lng: number;
  scooters: ScooterInput[];
  cc: string;
  when: Date;
}

/** Wspólne dla podglądu i wysyłki: walidacja wejścia + budowa wiadomości dla każdego operatora. */
async function buildDrafts(input: {
  lat: unknown;
  lng: unknown;
  scooters?: ScooterInput[];
  cc?: unknown;
  whenIso?: unknown;
}) {
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!inWarsaw(lat, lng)) return { ok: false as const, error: "outside_warsaw", status: 422 as const };
  const scooters = input.scooters;
  if (!Array.isArray(scooters) || scooters.length < 1 || scooters.length > MAX_SCOOTERS) {
    return { ok: false as const, error: "bad_scooters", status: 400 as const };
  }

  const items: { index: number; operator: string; code: string; id: string; hasQr: boolean }[] = [];
  for (const [index, sc] of scooters.entries()) {
    const code = clean(sc?.code, 500);
    const operator = detectOperator(code)?.key ?? sc?.operator;
    if (!code || !operator || !operatorByKey(operator)) return { ok: false as const, error: "bad_scooters", status: 400 as const };
    items.push({ index, operator, code, id: clean(extractScooterId(code), 100), hasQr: sc?.hasQr !== false });
  }

  const seen = new Set<string>();
  for (const it of items) {
    const k = `${it.operator}:${normalizeId(it.id)}`;
    if (seen.has(k)) return { ok: false as const, error: "duplicate_in_request", status: 409 as const };
    seen.add(k);
  }

  const ccRaw = clean(input.cc, 254);
  if (ccRaw && !EMAIL_RE.test(ccRaw)) return { ok: false as const, error: "bad_cc", status: 400 as const };

  // Data ze zgłoszenia zatwierdzonego w podglądzie (max ±30 min od teraz), inaczej bieżąca
  let when = new Date();
  const given = typeof input.whenIso === "string" ? new Date(input.whenIso) : null;
  if (given && Math.abs(given.getTime() - when.getTime()) < 30 * 60000) when = given;

  const geo = await reverseGeocode(lat, lng);
  const street = geo.street || "adres nieustalony";
  const address = `${street}, Warszawa`;
  const whenText = when.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" });

  const groups = new Map<string, typeof items>();
  for (const it of items) groups.set(it.operator, [...(groups.get(it.operator) ?? []), it]);

  const drafts = [...groups].map(([key, group]) => {
    const op = operatorByKey(key)!;
    const ids = group.map((g) => g.id);
    return {
      operator: key,
      name: op.name,
      to: op.email,
      cc: ccRaw || null,
      phone: op.phone ?? null,
      formUrl: op.formUrl ?? null,
      subject: `Źle zaparkowana hulajnoga ${op.name} – ${ids[0]} (${street})`,
      body: [
        "Dzień dobry,",
        "",
        `zgłaszam nieprawidłowo zaparkowaną hulajnogę ${op.name}, która utrudnia ruch pieszych lub stwarza zagrożenie.`,
        "",
        `Numer hulajnogi: ${group[0].id}`,
        `Adres: ${address}`,
        `Współrzędne GPS: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        `Mapa: https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`,
        `Data zgłoszenia: ${whenText}`,
        "",
        group[0].hasQr
          ? "W załączeniu przesyłam zdjęcie kodu QR hulajnogi oraz zdjęcia pokazujące, jak i gdzie została pozostawiona."
          : "W załączeniu przesyłam zdjęcia pokazujące, jak i gdzie została pozostawiona hulajnoga. Numer został wpisany ręcznie, dlatego nie ma zdjęcia kodu QR.",
        "Proszę o niezwłoczne przestawienie lub zabranie hulajnogi.",
        "",
        "Pozdrawiam",
      ].join("\n"),
      // Fragmenty, które interfejs wyróżnia badge'ami
      highlights: { to: op.email, ids, street, address, when: whenText },
      photoIndexes: group.map((g) => g.index),
    };
  });

  return { ok: true as const, lat, lng, geo, street, whenIso: when.toISOString(), cc: ccRaw || null, drafts };
}

/** Podgląd wiadomości, które pójdą do operatorów. Bez zapisu i bez wysyłki. */
async function preview(request: Request, env: Env): Promise<Response> {
  let input: Parameters<typeof buildDrafts>[0];
  try {
    input = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const r = await buildDrafts(input);
  if (!r.ok) return json({ error: r.error }, r.status);
  const dupes = await alreadyReported(env, r.drafts.flatMap((d) => d.highlights.ids.map((id) => ({ operator: d.operator, id }))));
  if (dupes.length) return json({ error: "duplicate", duplicates: dupes }, 409);
  const quota = await quotaState(env);
  if (quota.remaining < r.drafts.length) {
    return json({ error: quota.daily.remaining < r.drafts.length ? "quota_daily" : "quota_monthly", needed: r.drafts.length, quota }, 429);
  }
  return json({
    quota,
    street: r.street,
    whenIso: r.whenIso,
    messages: r.drafts.map(({ photoIndexes, ...m }) => ({ ...m, from: env.FROM_EMAIL, photoCount: photoIndexes.length })),
  });
}

/** Wysyłka: Turnstile, zdjęcia z załącznikami, mail do operatora (DW: użytkownik), statystyki w D1. */
async function createReport(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (!(await verifyTurnstile(String(form.get("turnstile") ?? ""), request.headers.get("CF-Connecting-IP"), env))) {
    return json({ error: "turnstile_failed" }, 403);
  }

  let scooters: ScooterInput[];
  try {
    scooters = JSON.parse(String(form.get("scooters") ?? "[]"));
  } catch {
    return json({ error: "bad_scooters" }, 400);
  }

  const r = await buildDrafts({
    lat: form.get("lat"),
    lng: form.get("lng"),
    scooters,
    cc: form.get("cc"),
    whenIso: form.get("whenIso"),
  });
  if (!r.ok) return json({ error: r.error }, r.status);

  // Zdjęcia hulajnogi i: photo{i}_0 = kod QR, photo{i}_1.. = dokumentacja
  const photos: File[][] = [];
  for (let i = 0; i < scooters.length; i++) {
    const list: File[] = [];
    for (let j = 0; j < MAX_PHOTOS; j++) {
      const f = form.get(`photo${i}_${j}`) as unknown as File | string | null;
      if (!f) break;
      if (typeof f === "string" || f.size === 0 || f.size > MAX_PHOTO_BYTES) return json({ error: "bad_photo" }, 400);
      list.push(f);
    }
    if (list.length < minPhotos(scooters[i].hasQr)) return json({ error: "need_photos" }, 400);
    photos.push(list);
  }
  for (const d of r.drafts) {
    const bytes = d.photoIndexes.flatMap((i) => photos[i]).reduce((s, f) => s + f.size, 0);
    if (bytes > MAX_GROUP_BYTES) return json({ error: "too_large" }, 413);
  }

  const dupes = await alreadyReported(env, r.drafts.flatMap((d) => d.highlights.ids.map((id) => ({ operator: d.operator, id }))));
  if (dupes.length) return json({ error: "duplicate", duplicates: dupes }, 409);

  const reserved = await reserveQuota(env, r.drafts.length);
  if (!reserved.ok) return json({ error: reserved.error, needed: r.drafts.length, quota: reserved.quota }, 429);

  const district = r.geo.district || "Nieustalona";
  const hour = new Date().toISOString().slice(0, 13);
  const keepFrom = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 13);
  const bump = "ON CONFLICT DO UPDATE SET scooters = scooters + excluded.scooters";

  const results: { operator: string; name: string; count: number; status: "sent" | "failed" }[] = [];
  for (const d of r.drafts) {
    try {
      const attachments: Attachment[] = [];
      for (const [n, i] of d.photoIndexes.entries()) {
        const id = d.highlights.ids[n]?.replace(/[^\w.-]/g, "_") || String(n + 1);
        for (const [j, file] of photos[i].entries()) {
          attachments.push({
            content: toBase64(await file.arrayBuffer()),
            filename: scooters[i].hasQr !== false && j === 0 ? `hulajnoga-${id}-kod-qr.jpg` : `hulajnoga-${id}-dokumentacja-${scooters[i].hasQr !== false ? j : j + 1}.jpg`,
            type: "image/jpeg",
            disposition: "attachment",
          });
        }
      }
      await sendMail(env, { to: d.to, cc: d.cc ?? undefined, subject: d.subject, text: d.body, attachments });
    } catch (e) {
      console.error("mail failed", d.operator, e);
      results.push({ operator: d.operator, name: d.name, count: d.photoIndexes.length, status: "failed" });
      continue;
    }

    // Do bazy trafiają wyłącznie statystyki – bez zdjęć, kodów QR, treści maila i adresu użytkownika
    const count = d.photoIndexes.length;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO reports (id, street, district, lat, lng, operator, scooter_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), r.street, r.geo.district || null, r.lat, r.lng, d.operator, count),
      env.DB.prepare(`INSERT INTO stats_hourly (hour, operator, district, scooters) VALUES (?, ?, ?, ?) ${bump}`).bind(hour, d.operator, district, count),
      env.DB.prepare(`INSERT INTO stats_totals (kind, key, scooters) VALUES ('operator', ?, ?) ${bump}`).bind(d.operator, count),
      env.DB.prepare(`INSERT INTO stats_totals (kind, key, scooters) VALUES ('district', ?, ?) ${bump}`).bind(district, count),
      env.DB.prepare("DELETE FROM stats_hourly WHERE hour < ?").bind(keepFrom),
      ...(await Promise.all(d.highlights.ids.map((id) => scooterKey(env, d.operator, id)))).map((k) =>
        env.DB.prepare("INSERT OR IGNORE INTO reported_scooters (key) VALUES (?)").bind(k),
      ),
      env.DB.prepare("DELETE FROM reported_scooters WHERE key < ?").bind(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)),
    ]);
    results.push({ operator: d.operator, name: d.name, count, status: "sent" });
  }

  const failedCount = results.filter((x) => x.status === "failed").length;
  // Niewysłane wiadomości nie zużywają limitu
  if (failedCount) await bumpQuota(env, -failedCount);
  return json({ ok: !failedCount, street: r.street, results, quota: await quotaState(env) }, failedCount ? 502 : 200);
}
