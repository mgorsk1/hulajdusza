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
INSERT INTO stats_totals (kind, key, scooters)
  SELECT 'city', COALESCE(city, 'Nieustalone'), SUM(scooter_count) FROM reports GROUP BY 2;

DELETE FROM stats_city_district;
INSERT INTO stats_city_district (city, district, scooters)
  SELECT COALESCE(city, 'Nieustalone'), COALESCE(district, 'Nieustalona'), SUM(scooter_count)
  FROM reports GROUP BY 1, 2;

DELETE FROM stats_city_operator;
INSERT INTO stats_city_operator (city, operator, scooters)
  SELECT COALESCE(city, 'Nieustalone'), operator, SUM(scooter_count) FROM reports GROUP BY 1, 2;

-- Liczniki limitów: dni z ostatnich 35 dni oraz bieżący i poprzednie miesiące
DELETE FROM quota_usage;
INSERT INTO quota_usage (period, used)
  SELECT 'd:' || substr(created_at, 1, 10), COUNT(*) FROM reports
  WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-35 days') GROUP BY 1;
INSERT INTO quota_usage (period, used)
  SELECT 'm:' || substr(created_at, 1, 7), COUNT(*) FROM reports GROUP BY 1;
