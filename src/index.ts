import { OPERATORS, detectOperator, extractScooterId, operatorByKey } from "./operators";

interface EmailAttachment {
  content: string;
  filename: string;
  type: string;
  disposition: "attachment";
}
interface EmailBinding {
  send(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments?: EmailAttachment[];
  }): Promise<unknown>;
}

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EMAIL: EmailBinding;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  EMAIL_DRY_RUN: string;
  FROM_EMAIL: string;
  OPERATOR_EMAILS: string;
  /** Sekundy cache dla /api/stats (0 = wyłączony, np. lokalnie). */
  STATS_CACHE_TTL?: string;
}

interface ScooterInput {
  operator: string;
  code: string;
}

const MAX_SCOOTERS = 5;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
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
    if (pathname === "/api/report" && request.method === "POST") return createReport(request, env);
    if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

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

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const clean = (s: unknown, max = 200) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

async function createReport(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const ok = await verifyTurnstile(
    String(form.get("turnstile") ?? ""),
    request.headers.get("CF-Connecting-IP"),
    env,
  );
  if (!ok) return json({ error: "turnstile_failed" }, 403);

  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));
  if (!inWarsaw(lat, lng)) {
    return json({ error: "outside_warsaw" }, 422);
  }

  let scooters: ScooterInput[];
  try {
    scooters = JSON.parse(String(form.get("scooters") ?? "[]"));
  } catch {
    return json({ error: "bad_scooters" }, 400);
  }
  if (!Array.isArray(scooters) || scooters.length < 1 || scooters.length > MAX_SCOOTERS) {
    return json({ error: "bad_scooters" }, 400);
  }

  // Walidacja, ustalenie operatora i zdjęć
  let total = 0;
  const items: { operator: string; code: string; id: string; photo: File }[] = [];
  for (let i = 0; i < scooters.length; i++) {
    const code = clean(scooters[i]?.code, 500);
    const operator = detectOperator(code)?.key ?? scooters[i]?.operator;
    const photo = form.get(`photo${i}`) as unknown as File | string | null;
    if (!code || !operator || !operatorByKey(operator)) return json({ error: "bad_scooters" }, 400);
    if (!photo || typeof photo === "string" || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
      return json({ error: "bad_photo" }, 400);
    }
    total += photo.size;
    items.push({ operator, code, id: clean(extractScooterId(code), 100), photo });
  }
  if (total > MAX_TOTAL_BYTES) return json({ error: "too_large" }, 413);

  const geo = await reverseGeocode(lat, lng);
  const street = geo.street || "adres nieustalony";
  const emails = JSON.parse(env.OPERATOR_EMAILS || "{}") as Record<string, string>;
  const dryRun = env.EMAIL_DRY_RUN !== "false";
  const when = new Date().toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" });

  // Jedno zgłoszenie (mail + wiersz w D1) na operatora
  const byOperator = new Map<string, typeof items>();
  for (const it of items) byOperator.set(it.operator, [...(byOperator.get(it.operator) ?? []), it]);

  const results: { operator: string; count: number; id?: string; error?: string }[] = [];
  for (const [key, group] of byOperator) {
    const op = operatorByKey(key)!;
    const to = emails[key];
    if (!to) {
      results.push({ operator: key, count: group.length, error: "no_email" });
      continue;
    }

    const subject = `Źle zaparkowana hulajnoga ${op.name} – ${group.map((g) => g.id).join(", ")} (${street})`;
    const text = [
      "Dzień dobry,",
      "",
      `zgłaszam nieprawidłowo zaparkowane hulajnogi ${op.name} (liczba: ${group.length}), które utrudniają ruch pieszych / stwarzają zagrożenie.`,
      "",
      "Hulajnogi:",
      ...group.map((g, n) => `${n + 1}. ID: ${g.id} (zawartość kodu QR: ${g.code})`),
      "",
      `Adres: ${street}, Warszawa`,
      `Współrzędne GPS: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      `Mapa: https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`,
      `Data zgłoszenia: ${when}`,
      "",
      "Zdjęcia dokumentujące w załączeniu. Proszę o niezwłoczne przestawienie lub zabranie pojazdów.",
      "",
      "Zgłoszenie wysłane automatycznie przez Hulajdusza.",
    ].join("\n");

    try {
      if (dryRun) {
        console.log(`[DRY RUN] mail do ${to}\n${subject}\n${text}\nzałączniki: ${group.length}`);
      } else {
        const attachments: EmailAttachment[] = [];
        for (const g of group) {
          attachments.push({
            content: toBase64(await g.photo.arrayBuffer()),
            filename: `hulajnoga-${g.id.replace(/[^\w.-]/g, "_")}.jpg`,
            type: "image/jpeg",
            disposition: "attachment",
          });
        }
        await env.EMAIL.send({ from: env.FROM_EMAIL, to, subject, text, attachments });
      }
    } catch (e) {
      console.error("email failed", key, e);
      results.push({ operator: key, count: group.length, error: "email_failed" });
      continue;
    }

    // Do bazy trafiają wyłącznie statystyki – bez zdjęć i kodów QR
    const id = crypto.randomUUID();
    const district = geo.district || "Nieustalona";
    const hour = new Date().toISOString().slice(0, 13);
    const keepFrom = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 13);
    const bump = "ON CONFLICT DO UPDATE SET scooters = scooters + excluded.scooters";
    // Zgłoszenie + agregaty atomowo: statystyki nigdy nie rozjadą się z tabelą reports
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO reports (id, street, district, lat, lng, operator, scooter_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, street, geo.district || null, lat, lng, key, group.length),
      env.DB.prepare(`INSERT INTO stats_hourly (hour, operator, district, scooters) VALUES (?, ?, ?, ?) ${bump}`).bind(hour, key, district, group.length),
      env.DB.prepare(`INSERT INTO stats_totals (kind, key, scooters) VALUES ('operator', ?, ?) ${bump}`).bind(key, group.length),
      env.DB.prepare(`INSERT INTO stats_totals (kind, key, scooters) VALUES ('district', ?, ?) ${bump}`).bind(district, group.length),
      env.DB.prepare("DELETE FROM stats_hourly WHERE hour < ?").bind(keepFrom),
    ]);
    results.push({ operator: key, count: group.length, id });
  }

  const failed = results.some((r) => r.error);
  return json({ ok: !failed, street, results }, failed ? 502 : 200);
}
