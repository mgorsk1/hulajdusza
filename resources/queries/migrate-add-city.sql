-- Backfill: dodaje kolumnę `city` do istniejącej tabeli `reports` i wypełnia ją dla wierszy sprzed tej zmiany.
-- Jednorazowe, na bazę bez kolumny `city`. Uruchom: task db:migrate-city:remote (albo :city dla lokalnej bazy).
--
-- SQLite (D1) nie zna `ADD COLUMN IF NOT EXISTS`, więc powtórne uruchomienie na bazie, która już ma tę kolumnę,
-- zakończy się błędem "duplicate column name: city" na pierwszej linii — to nieszkodliwy sygnał, że migracja
-- była już zastosowana; UPDATE niżej i tak nie miałby czego dokładać.
--
-- Wszystkie istniejące wiersze mają lat/lng zweryfikowane przy zgłoszeniu przez WARSAW bbox (inWarsaw), więc
-- backfill nie odpytuje ponownie Nominatim (uniknięcie rate-limitu) — wystarczy wpisać stałe "Warszawa".
-- Statystyk (stats_hourly/stats_totals) ta migracja celowo nie dotyka — do przebudowy osobno, później.
ALTER TABLE reports ADD COLUMN city TEXT;
CREATE INDEX IF NOT EXISTS idx_reports_city ON reports (city);

UPDATE reports SET city = 'Warszawa' WHERE city IS NULL;
