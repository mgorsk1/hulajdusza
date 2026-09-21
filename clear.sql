-- Czyszczenie wszystkich danych w bazie (zgłoszenia, statystyki, limity, blokady duplikatów).
DELETE FROM reports;
DELETE FROM stats_hourly;
DELETE FROM stats_totals;
DELETE FROM quota_usage;
DELETE FROM reported_scooters;
