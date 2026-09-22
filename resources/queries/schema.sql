CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  street TEXT,
  district TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  operator TEXT NOT NULL,
  scooter_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);

-- Agregaty do statystyk: aktualizowane przyrostowo przy każdym zgłoszeniu (w tej samej transakcji co INSERT do reports),
-- dzięki czemu /api/stats nigdy nie skanuje tabeli reports.
-- Kubełki godzinowe (24 h, poprzednie 24 h, wykres 30 dni). Przycinane do ~35 dni.
CREATE TABLE IF NOT EXISTS stats_hourly (
  hour TEXT NOT NULL,          -- 'YYYY-MM-DDTHH' (UTC)
  operator TEXT NOT NULL,
  district TEXT NOT NULL,
  scooters INTEGER NOT NULL,
  PRIMARY KEY (hour, operator, district)
) WITHOUT ROWID;

-- Sumy od początku, per operator i per dzielnica (kilkanaście wierszy).
CREATE TABLE IF NOT EXISTS stats_totals (
  kind TEXT NOT NULL,          -- 'operator' | 'district'
  key TEXT NOT NULL,
  scooters INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;

-- Liczniki limitów zgłoszeń (1 zgłoszenie = 1 wiadomość do operatora): 'd:YYYY-MM-DD' i 'm:YYYY-MM' (UTC).
CREATE TABLE IF NOT EXISTS quota_usage (
  period TEXT PRIMARY KEY,
  used INTEGER NOT NULL
) WITHOUT ROWID;

-- Hulajnogi zgłoszone danego dnia (doba wg czasu Warszawy). Klucz = 'YYYY-MM-DD:' + HMAC-SHA-256(sekret, data|operator|numer),
-- czyli bez surowych numerów, których nie da się też odzyskać zgadywaniem. Służy tylko do blokowania powtórnych zgłoszeń, wpisy starsze niż 2 dni są usuwane.
CREATE TABLE IF NOT EXISTS reported_scooters (
  key TEXT PRIMARY KEY
) WITHOUT ROWID;
