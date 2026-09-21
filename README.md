# Hulajdusza

Zgłaszanie źle zaparkowanych hulajnóg w Warszawie (Bolt, Lime, Dott). Cloudflare Workers (static assets + API), D1, Turnstile.

## Start
```bash
task install && task dev      # http://localhost:8787 (dev sam wczytuje schemat i przykładowe dane)
```
`task --list` wypisuje wszystkie akcje. Nie uruchamiaj `task db:*` przy działającym `task dev`.

Pełna instrukcja wdrożenia na Cloudflare: [DEPLOY.md](DEPLOY.md).

## Jak działa zgłoszenie
Kreator w 4 krokach:
1. **Kod QR.** Skanowany wyłącznie na żywo aparatem. Gdy tylko kod zostanie odczytany, aplikacja sama robi zdjęcie klatki (to zdjęcie kodu QR). Odczyt robi przeglądarka (BarcodeDetector lub jsQR), a backend (`/api/check`) tylko ustala operatora i numer oraz sprawdza, czy hulajnoga była już dziś zgłoszona. Gdy skanowanie się nie da, jest wpis numeru ręcznie.
2. **Zdjęcie hulajnogi.** Co najmniej jedno (do dwóch) zdjęcie pokazujące, gdzie i jak stoi hulajnoga. Do maila trafia razem ze zdjęciem kodu QR. Przy numerze wpisanym ręcznie (bez zdjęcia kodu) wystarcza jedno zdjęcie hulajnogi. Jedno zgłoszenie dotyczy jednej hulajnogi: „Dalej” prowadzi od razu do kroku 3.
3. **Kopia.** Opcjonalny adres e-mail użytkownika trafia do DW. Zapamiętywany tylko w `localStorage`, w bazie go nie ma.
4. **Potwierdzenie.** `/api/preview` zwraca gotowe wiadomości (nieedytowalne), użytkownik zaznacza „Sprawdziłem”, przechodzi Turnstile i wysyła. Dopiero `/api/report` wysyła maile ze zdjęciami w załącznikach.

Do bazy trafiają wyłącznie statystyki (uuid, adres, GPS, operator, liczba hulajnóg). Zdjęcia, treść maila i adres użytkownika nie są zapisywane.

## Ochrona przed nadużyciami
- **Turnstile** na wysyłce. W `wrangler.jsonc` klucz testowy `3x00000000000000000000FF` zawsze wymusza interaktywne potwierdzenie i zawsze przechodzi.
- **Limity:** `DAILY_LIMIT` (domyślnie 100) i `MONTHLY_LIMIT` (3000). 1 zgłoszenie = 1 mail do operatora (zgłoszenie z hulajnogami dwóch operatorów to 2). Doba i miesiąc liczone w UTC. Pozostała pula: `GET /api/quota`, pokazywana pod nawigacją.
- **Jedna hulajnoga raz dziennie.** Powtórka (ten sam operator i numer, doba wg czasu Warszawy) jest oznaczana już przy analizie zdjęcia i blokowana w podglądzie oraz przy wysyłce. W tabeli `reported_scooters` trzymamy tylko skrót HMAC-SHA-256 z sekretnym kluczem (`HASH_SECRET`), którego nie da się odwrócić ani odtworzyć zgadywaniem numerów. Wpisy starsze niż 2 dni znikają.

## Wysyłka maili
Zmienna `MAIL_PROVIDER`:
- `cloudflare` (domyślnie): binding `send_email` (Cloudflare Email Service). Wymaga **Workers Paid** (5 USD/mies., w tym 3000 maili) i domeny na Cloudflare DNS.
- `resend`: darmowy plan (3000/mies., 100/dzień), klucz: `task secret:resend`. Wymaga zweryfikowanej domeny nadawcy.

`EMAIL_DRY_RUN` = `"true"` (domyślnie) tylko loguje maile. Ustaw `"false"`, gdy nadawca jest skonfigurowany. Ustaw też `FROM_EMAIL`.

## Plan Workers
Aplikacja działa na planie **Workers Free**: odczyt QR jest w przeglądarce, a backend robi tylko proste zapytania. Plan Paid jest potrzebny wyłącznie do Cloudflare Email Service (`MAIL_PROVIDER=cloudflare`). Z Resendem (`MAIL_PROVIDER=resend`) zostajesz na Free.

## Wdrożenie
1. `task db:create` → `database_id` do `wrangler.jsonc`, potem `task db:remote`
2. Turnstile: własny widget, `TURNSTILE_SITE_KEY` w `wrangler.jsonc`, `task secret:turnstile`
3. Mail: patrz wyżej (`FROM_EMAIL`, `MAIL_PROVIDER`, `EMAIL_DRY_RUN`)
4. `task deploy`

Istniejąca baza: `task db:remote && task db:rebuild-stats:remote` (backfill agregatów statystyk i liczników limitów).

## Statystyki bez skanowania bazy
`/api/stats` czyta tylko agregaty `stats_hourly` i `stats_totals`, aktualizowane przyrostowo w tej samej transakcji D1 co zgłoszenie, plus cache na krawędzi (`STATS_CACHE_TTL`, lokalnie 0).

## Operatorzy
Lista, kolory, wzorce rozpoznawania kodu QR i kontakty: `src/operators.ts`. Hulajnogi Lime z aplikacji Uber to nadal Lime (kod QR Lime).
