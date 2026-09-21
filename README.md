# Hulajdusza

Zgłaszanie źle zaparkowanych hulajnóg w Warszawie. Cloudflare Workers (static assets + API), D1, Turnstile, Email Service.

## Start
```bash
task install && task db:seed && task dev   # http://localhost:8787 (db:seed = przykładowe dane)
```
`task` (go-task) wypisuje wszystkie akcje: `task --list`.

## Wdrożenie
1. `task db:create` → wpisz `database_id` do `wrangler.jsonc`, potem `task db:remote`
2. Turnstile: utwórz widget w dashboardzie, wpisz `TURNSTILE_SITE_KEY` w `wrangler.jsonc`, `task secret:turnstile`
3. Email: zweryfikuj domenę nadawcy w Cloudflare Email Service, ustaw `FROM_EMAIL`
4. Uzupełnij `OPERATOR_EMAILS` (adresy do zgłoszeń każdego operatora) i ustaw `EMAIL_DRY_RUN` na `"false"`
5. `task deploy`

## Operatorzy
Lista, kolory i wzorce rozpoznawania po kodzie QR: `src/operators.ts`.

## Statystyki bez skanowania bazy transakcyjnej
`/api/stats` nie dotyka tabeli `reports`. Przy każdym zgłoszeniu Worker w jednej transakcji D1 (`batch`) zapisuje zgłoszenie i podbija agregaty:
- `stats_hourly` – kubełki godzinowe (operator × dzielnica), przycinane do ~35 dni; z nich 24 h, poprzednie 24 h i wykres 30 dni,
- `stats_totals` – sumy per operator i per dzielnica (kilkanaście wierszy).

Dodatkowo odpowiedź jest cache'owana na krawędzi (`STATS_CACHE_TTL`, domyślnie 60 s; lokalnie 0). Odczyt to kilkadziesiąt wierszy, a D1 dostaje co najwyżej jedno zapytanie na TTL na lokalizację.
Przy wdrożeniu na istniejącą bazę: `task db:remote && task db:rebuild-stats:remote` (backfill agregatów z `reports`).
