export interface Operator {
  key: string;
  name: string;
  /** Kolor marki na jasnym tle / na ciemnym tle. */
  color: string;
  dark: string;
  /** Regex source dopasowywany do treści kodu QR (host / nazwa marki). */
  match: string;
  /** Kontakt do zgłoszeń o źle zaparkowanych hulajnogach. */
  email: string;
  phone?: string;
  formUrl?: string;
}

// Operatorzy hulajnóg elektrycznych działający w polskich miastach (Bolt, Dott, Lime).
// Hulajnogi Lime dostępne w aplikacji Uber to nadal hulajnogi Lime – ich kod QR jest kodem Lime.
export const OPERATORS: Operator[] = [
  {
    key: "lime",
    name: "Lime",
    color: "#bef000",
    dark: "#bef000",
    match: "li\\.me|limebike|lime\\.bike|limeapp|\\blime\\b",
    email: "pomoc@li.me",
    phone: "+48 32 224 71 22",
  },
  {
    key: "bolt",
    name: "Bolt",
    color: "#34d186",
    dark: "#34d186",
    match: "taxify\\.eu|taxify\\.me|taxify\\.com|bolt\\.eu|bolt\\.com|\\btaxify\\b|\\bbolt\\b",
    email: "poland@bolt.eu",
    phone: "+48 22 307 83 67",
    formUrl: "https://bolt.eu/pl-pl/scooters/report/",
  },
  {
    key: "dott",
    name: "Dott",
    color: "#00a3e2",
    dark: "#00a3e2",
    match: "dott\\.com|ridedott|dott\\.app|\\bdott\\b",
    email: "support@ridedott.com",
  },
  {
    key: "other",
    name: "Inny",
    color: "#9ca3af",
    dark: "#9ca3af",
    // "(?!)" nigdy się nie dopasowuje (negative lookahead na pusty ciąg) – operator tylko do ręcznego wyboru
    // w kroku "Wpisz numer ręcznie", nigdy z automatycznego rozpoznania kodu QR. Do testów; łatwo odfiltrować
    // i wyczyścić później po key = "other".
    match: "(?!)",
    email: "gorskimariusz13@gmail.com",
  },
];

export const operatorByKey = (key: string) => OPERATORS.find((o) => o.key === key);

export function detectOperator(code: string): Operator | undefined {
  return OPERATORS.find((o) => new RegExp(o.match, "i").test(code));
}

/** Wyciąga identyfikator pojazdu z treści QR (URL albo goły kod). */
export function extractScooterId(code: string): string {
  const raw = code.trim();
  try {
    const u = new URL(raw);
    for (const p of ["id", "vehicle", "vehicle_id", "vehicleId", "code", "qr", "v"]) {
      const v = u.searchParams.get(p);
      if (v) return v;
    }
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
  } catch {
    /* nie URL */
  }
  return raw;
}
