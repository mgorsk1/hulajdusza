-- Czyszczenie wszystkich danych w bazie (zgłoszenia, statystyki, limity, blokady duplikatów).
DELETE FROM reports;
DELETE FROM stats_hourly;
DELETE FROM stats_totals;
DELETE FROM stats_city_district;
DELETE FROM stats_city_operator;
DELETE FROM quota_usage;
DELETE FROM reported_scooters;
