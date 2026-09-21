export interface Operator {
  key: string;
  name: string;
  /** Kolor marki na jasnym tle / na ciemnym tle (Uber i Tier mają jaśniejszy odpowiednik, bo czerń i granat nie są widoczne na ciemnym). */
  color: string;
  dark: string;
  /** Regex source dopasowywany do treści kodu QR (host / nazwa marki). */
  match: string;
}

// Operatorzy hulajnóg elektrycznych w Warszawie.
export const OPERATORS: Operator[] = [
  { key: "lime", name: "Lime", color: "#bef000", dark: "#bef000", match: "li\\.me|limebike|lime\\.bike|limeapp|\\blime\\b" },
  { key: "bolt", name: "Bolt", color: "#34d186", dark: "#34d186", match: "bolt\\.eu|bolt\\.com|\\bbolt\\b" },
  { key: "dott", name: "Dott", color: "#00a3e2", dark: "#00a3e2", match: "dott\\.com|ridedott|dott\\.app|\\bdott\\b" },
  { key: "voi", name: "Voi", color: "#ec6960", dark: "#ec6960", match: "voi\\.com|voiapp|\\bvoi\\b" },
  { key: "tier", name: "Tier", color: "#000f3a", dark: "#5f7ae0", match: "tier\\.app|tier-mobility|tier\\.link|\\btier\\b" },
  { key: "hive", name: "Hive", color: "#cbf700", dark: "#cbf700", match: "hive\\.app|hivemicromobility|\\bhive\\b" },
  { key: "uber", name: "Uber", color: "#000000", dark: "#ffffff", match: "uber\\.com|ubr\\.to|\\buber\\b" },
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
