CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  street TEXT,
  district TEXT,
  -- Miasto z odwrotnego geokodowania (obecnie zawsze "Warszawa", bo tylko stamtąd przyjmujemy zgłoszenia;
  -- kolumna gotowa pod przyszłe rozszerzenie na inne miasta). Na bazach sprzed tej kolumny: resources/queries/migrate-add-city.sql
  -- (task db:migrate-city / db:migrate-city:remote) — CREATE TABLE IF NOT EXISTS niżej nie doda kolumny do istniejącej tabeli.
  city TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  operator TEXT NOT NULL,
  scooter_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_city ON reports (city);

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

-- Sumy od początku, per operator, per dzielnica (globalnie, wszystkie miasta razem) i per miasto (kilkanaście–kilkadziesiąt wierszy).
CREATE TABLE IF NOT EXISTS stats_totals (
  kind TEXT NOT NULL,          -- 'operator' | 'district' | 'city'
  key TEXT NOT NULL,
  scooters INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;

-- Sumy per dzielnica W OBRĘBIE miasta (sekcja "Statystyki miasta" na stronie statystyk, filtrowana po mieście).
-- Osobno od stats_totals(kind='district'), bo ten sam string dzielnicy może istnieć w kilku miastach.
CREATE TABLE IF NOT EXISTS stats_city_district (
  city TEXT NOT NULL,
  district TEXT NOT NULL,
  scooters INTEGER NOT NULL,
  PRIMARY KEY (city, district)
) WITHOUT ROWID;

-- Sumy per operator W OBRĘBIE miasta (lider operatorów w sekcji "Statystyki miasta"). Analogicznie do stats_city_district.
CREATE TABLE IF NOT EXISTS stats_city_operator (
  city TEXT NOT NULL,
  operator TEXT NOT NULL,
  scooters INTEGER NOT NULL,
  PRIMARY KEY (city, operator)
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
