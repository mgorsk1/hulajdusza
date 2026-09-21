-- Odbudowa agregatów z tabeli reports (backfill przy wdrożeniu na istniejącą bazę, naprawa po awarii, po seedzie).
-- Uruchom: task db:rebuild-stats
DELETE FROM stats_hourly;
INSERT INTO stats_hourly (hour, operator, district, scooters)
  SELECT substr(created_at, 1, 13), operator, COALESCE(district, 'Nieustalona'), SUM(scooter_count)
  FROM reports GROUP BY 1, 2, 3;

DELETE FROM stats_totals;
INSERT INTO stats_totals (kind, key, scooters)
  SELECT 'operator', operator, SUM(scooter_count) FROM reports GROUP BY operator;
INSERT INTO stats_totals (kind, key, scooters)
  SELECT 'district', COALESCE(district, 'Nieustalona'), SUM(scooter_count) FROM reports GROUP BY 2;
