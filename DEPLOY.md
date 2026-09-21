# Wdrożenie na Cloudflare – krok po kroku

Instrukcja dla obecnej wersji aplikacji (kreator zgłoszeń, D1, Turnstile, wysyłka maili). Zajmuje ok. 30–45 minut, z czego większość to konfiguracja poczty.

## 0. Zanim zaczniesz: wybierz wariant

Od tego zależy tylko konfiguracja poczty (krok 5). Kod QR czyta zawsze przeglądarka, więc sama aplikacja działa na planie Workers Free.

| | **Wariant A – Cloudflare (5 USD/mies.)** | **Wariant B – darmowy** |
|---|---|---|
| Plan Workers | **Workers Paid** (wymaga go Email Service) | Workers Free |
| Wysyłka maili | Cloudflare Email Service (3000 maili/mies. w cenie, potem 0,35 USD/1000) | Resend (3000/mies., 100/dzień) |
| Domena | musi być na **Cloudflare DNS** | dowolna, do której dodasz rekordy DNS |
| `MAIL_PROVIDER` | `cloudflare` | `resend` |

Uwaga: limit `DAILY_LIMIT=100` w aplikacji jest dobrany do planu darmowego Resend (100 maili dziennie). W wariancie A możesz go podnieść.

W obu wariantach potrzebujesz **własnej domeny** (adres nadawcy typu `zgloszenia@twoja-domena.pl`). Bez niej maile nie przejdą SPF/DKIM i wylądują w spamie.

## 1. Wymagania

- konto Cloudflare (darmowe wystarczy do kroków 1–4)
- Node.js 20+ i npm
- opcjonalnie [go-task](https://taskfile.dev) (`brew install go-task`). Wszędzie podaję też komendy bez niego.

```bash
cd hulajdusza
npm install                 # albo: task install
npx wrangler login          # otworzy przeglądarkę, zaloguj się do Cloudflare
npx wrangler whoami         # sprawdź, że widzisz swoje konto
```

## 2. Baza danych D1

```bash
npx wrangler d1 create hulajdusza      # albo: task db:create
```

Komenda wypisze blok z `database_id`. **Skopiuj ID** i wklej w `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "hulajdusza",
    "database_id": "TU-WKLEJ-ID"     // <- zamień placeholder 0000...
  }
]
```

Załóż tabele w bazie produkcyjnej:

```bash
npx wrangler d1 execute hulajdusza --remote --file=schema.sql     # albo: task db:remote
```

Powinno się utworzyć 5 tabel: `reports`, `stats_hourly`, `stats_totals`, `quota_usage`, `reported_scooters`. Sprawdź:

```bash
npx wrangler d1 execute hulajdusza --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Nie ładuj `seed.sql` na produkcję. To dane testowe tylko do lokalnego developmentu.

## 3. Turnstile (ochrona przed botami)

1. Dashboard Cloudflare → **Turnstile** → **Add widget**.
2. Nazwa: `hulajdusza`. **Hostname**: wpisz pełną nazwę hosta, pod którym będzie działać aplikacja (krok 8), np. `hulajdusza.TWOJ-SUBDOMENA.workers.dev` albo `zgloszenia.twoja-domena.pl`. Nazwy muszą być pełne (FQDN), bez wildcardów. Subdomeny wpisanego hosta też działają.
3. Tryb: **Managed**. Zapisz.
4. Skopiuj **Site key** i **Secret key**.

Site key (jest publiczny) wpisz w `wrangler.jsonc`:

```jsonc
"TURNSTILE_SITE_KEY": "0x4AAAAAAA..."      // zamiast testowego 3x00000000000000000000FF
```

Secret key ustaw jako sekret (nigdy w plikach):

```bash
npx wrangler secret put TURNSTILE_SECRET       # albo: task secret:turnstile
# wklej Secret key i Enter
```

Jeśli formularz odrzuci host `*.workers.dev`, użyj własnej domeny (krok 8) i wpisz jej host. Nie zdążyłem tego sprawdzić na koncie.

## 3b. Sekret do skrótów hulajnóg

Blokada powtórzeń zapisuje w bazie skróty HMAC, a nie numery hulajnóg. Potrzebuje własnego, losowego klucza (jeśli go nie ustawisz, użyty zostanie `TURNSTILE_SECRET`, co działa, ale lepiej mieć osobny):

```bash
openssl rand -hex 32                      # wygeneruj losowy ciąg
npx wrangler secret put HASH_SECRET       # albo: task secret:hash, wklej ciąg
```

Zmiana tego sekretu w przyszłości nie psuje niczego poza tym, że hulajnogi zgłoszone tego samego dnia przed zmianą przestaną być rozpoznawane jako powtórki.

## 4. Adres nadawcy

W `wrangler.jsonc`, w `vars`:

```jsonc
"FROM_EMAIL": "zgloszenia@twoja-domena.pl"
```

Ten adres musi należeć do domeny skonfigurowanej w kroku 5A albo 5B.

## 5A. Wariant A: Cloudflare Email Service

1. Przełącz konto na **Workers Paid**: Dashboard → **Workers & Pages** → **Plans** → Workers Paid (5 USD/mies.).
2. Domena musi być dodana do Cloudflare i korzystać z Cloudflare DNS (Dashboard → **Add a domain**, zmiana serwerów nazw u rejestratora).
3. Dashboard → **Compute** → **Email Service** → **Email Sending** → **Onboard Domain** → wybierz domenę. Cloudflare doda sam rekordy SPF, DKIM, DMARC i MX (dla `cf-bounce`). Propagacja zwykle trwa 5–15 min, maksymalnie 24 h.
4. W `wrangler.jsonc` zostaw:

```jsonc
"MAIL_PROVIDER": "cloudflare"
```

Blok `"send_email": [{ "name": "EMAIL" }]` już jest w pliku i nic nie trzeba zmieniać.

## 5B. Wariant B: darmowy (Resend)

1. Załóż konto na resend.com → **Domains** → **Add Domain** → wpisz domenę.
2. Resend poda rekordy DNS (SPF, DKIM, opcjonalnie DMARC). Dodaj je u dostawcy DNS (w Cloudflare: DNS → Records) i kliknij **Verify**.
3. **API Keys** → **Create API Key** (uprawnienie *Sending access*). Skopiuj klucz.
4. Ustaw sekret:

```bash
npx wrangler secret put RESEND_API_KEY        # albo: task secret:resend
```

5. W `wrangler.jsonc`:

```jsonc
"MAIL_PROVIDER": "resend"
```

6. Binding `send_email` nie jest w tym wariancie używany. Jeśli `wrangler deploy` narzeka na niego w planie Free (nie testowałem tego), usuń z `wrangler.jsonc` linię `"send_email": [{ "name": "EMAIL" }],`.

`EMAIL_DRY_RUN` zostaw na razie na `"true"` (krok 7).

## 6. Limity i ustawienia aplikacji

Wszystko w `wrangler.jsonc` → `vars`:

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `DAILY_LIMIT` | `100` | maks. zgłoszeń dziennie (1 zgłoszenie = 1 mail do operatora) |
| `MONTHLY_LIMIT` | `3000` | maks. zgłoszeń miesięcznie |
| `EMAIL_DRY_RUN` | `true` | `true` = maile tylko w logach, `false` = wysyłka naprawdę |
| `STATS_CACHE_TTL` | `60` | cache statystyk na krawędzi (sekundy) |

Doba i miesiąc dla limitów liczone są w UTC.

## 7. Pierwszy deploy (w trybie próbnym)

Najpierw wdróż z `EMAIL_DRY_RUN="true"`, żeby sprawdzić wszystko bez wysyłania maili do operatorów.

```bash
npm run typecheck            # musi przejść bez błędów
npx wrangler deploy          # albo: task deploy (typecheck + deploy)
```

Na końcu wypisze adres, np. `https://hulajdusza.TWOJ-SUBDOMENA.workers.dev`. Jeśli w kroku 3 wpisałeś inny host, wróć do Turnstile i popraw hostname.

Sprawdź API:

```bash
curl https://TWOJ-ADRES/api/config      # lista operatorów i site key
curl https://TWOJ-ADRES/api/quota       # {"daily":{"used":0,"limit":100,...}}
curl https://TWOJ-ADRES/api/stats       # puste statystyki
```

Podgląd logów na żywo:

```bash
npx wrangler tail            # albo: task logs
```

## 8. Test na telefonie (obowiązkowo przed włączeniem maili)

Kamera i GPS działają tylko po HTTPS, a adres z kroku 7 jest HTTPS. Otwórz go na telefonie i przejdź cały kreator:

1. Dotknij „Zeskanuj kod QR” i skieruj aparat na kod wyświetlony na ekranie (np. z tekstem `https://li.me/scan/123-456`). Aplikacja odczyta go sama.
2. Sprawdź, czy rozpoznało operatora i numer, potem zrób zdjęcie hulajnogi (krok 2).
3. Krok 2: wpisz swój e-mail (albo „Pomiń”).
4. Krok 3: sprawdź wiadomość, przejdź Turnstile, kliknij „Wygląda ok, wysyłamy!”.
5. W `npx wrangler tail` powinien pojawić się log `[DRY RUN] od: ... do: ... temat: ...` z liczbą załączników.
6. Wejdź na `/stats` i `/map`. Zgłoszenie powinno się tam pojawić.
7. Spróbuj zgłosić **to samo** ponownie: aplikacja powinna zablokować drugie zgłoszenie tego dnia.


## 9. Własna subdomena (np. zgloszenia.twoja-domena.pl lub hulajdusza.twoja-domena.pl)

Aby aplikacja działała pod Twoją subdomeną (np. `hulajdusza.twoja-domena.pl` zamiast `*.workers.dev`):

### Krok 1: Podpięcie subdomeny do Workera
Główna domena (`twoja-domena.pl`) musi być dodana w Twoim koncie Cloudflare i obsługiwana przez Cloudflare DNS.

**Sposób A: Przez Dashboard Cloudflare (najprostszy)**:
1. W Cloudflare Dashboard przejdź do: **Workers & Pages** → **Overview** → kliknij `hulajdusza`.
2. Zakładka **Settings** → **Domains & Routes**.
3. W sekcji **Custom Domains** kliknij **Add** → **Custom Domain**.
4. Wpisz pełną subdomenę, np. `hulajdusza.twoja-domena.pl` (albo `zgloszenia.twoja-domena.pl`) i kliknij **Add Custom Domain**.
5. Cloudflare automatycznie:
   - Utworzy rekord DNS w strefie Twojej domeny.
   - Wygeneruje i podepnie darmowy certyfikat SSL/TLS (HTTPS).
   - Skonfiguruje routing do Workera.

**Sposób B: Przez konfigurację `wrangler.jsonc`**:
Możesz też dodać trasę bezpośrednio w pliku `wrangler.jsonc`:
```jsonc
"routes": [
  { "pattern": "hulajdusza.twoja-domena.pl/*", "custom_domain": true }
]
```
I uruchomić `npx wrangler deploy`.

---

### Krok 2: Zaktualizuj Turnstile (anty-spam)
Widget Cloudflare Turnstile weryfikuje domenę, z której przychodzi zgłoszenie:
1. Przejdź do: Cloudflare Dashboard → **Turnstile**.
2. Wybierz swój widget (utworzony w kroku 3).
3. W sekcji **Domains** dodaj swoją subdomenę (np. `hulajdusza.twoja-domena.pl`) lub domenę główną (`twoja-domena.pl`).
4. Zapisz zmiany.

---

### Krok 3: Dopasuj adres nadawcy maili (`FROM_EMAIL`)
W pliku `wrangler.jsonc` ustaw adres e-mail nadawcy zgodny z Twoją domeną:
```jsonc
"vars": {
  "FROM_EMAIL": "zgloszenia@twoja-domena.pl",
  // ...
}
```
Następnie wdróż zmiany:
```bash
npx wrangler deploy
```

---

### Krok 4: Wyłączenie domyślnego adresu *.workers.dev (opcjonalnie)
Gdy subdomena już działa i chcesz, aby aplikacja była dostępna **wyłącznie** pod Twoją subdomeną:
1. W Dashboardzie: **Workers & Pages** → `hulajdusza` → **Settings** → **Domains & Routes**.
2. Przy domenie `*.workers.dev` kliknij menu z trzema kropkami `...` → **Disable**.

## 10. Włączenie prawdziwej wysyłki

**Najpierw sprawdź adresy operatorów.** Kontakty w `src/operators.ts` (`poland@bolt.eu`, `pomoc@li.me`, `support@ridedott.com`) pochodzą z serwisów miast, a nie od samych operatorów. Nie wiadomo, czy te skrzynki obsługują zgłoszenia o parkowaniu. Bolt oficjalnie prowadzi do formularza. Zanim uruchomisz ruch, napisz do każdego z nich testową wiadomość i zapytaj, czy przyjmą zgłoszenia mailem.

**Test wysyłki na własny adres** (żeby nie wysyłać testów do operatorów):

1. W `src/operators.ts` tymczasowo podmień e-mail jednego operatora (np. Lime) na swój adres.
2. W `wrangler.jsonc` ustaw `"EMAIL_DRY_RUN": "false"` i wdróż (`npx wrangler deploy`).
3. Wykonaj jedno zgłoszenie na telefonie. Sprawdź skrzynkę i spam: temat, treść, dwa załączniki ze zdjęciami, adres nadawcy.
4. Przywróć właściwy e-mail w `src/operators.ts`, wdróż ponownie.

Jeśli mail nie dochodzi: w `npx wrangler tail` szukaj `mail failed`. Częste przyczyny: domena nie zweryfikowana (5A/5B), zły `FROM_EMAIL`, brak `RESEND_API_KEY` (błąd 401).

## 11. Aktualizacje i baza

- Zmiana kodu: `npx wrangler deploy`.
- Zmiana schematu (`schema.sql` używa `CREATE TABLE IF NOT EXISTS`, więc bezpiecznie): `npx wrangler d1 execute hulajdusza --remote --file=schema.sql`.
- Istniejąca baza po dodaniu nowych tabel agregatów: `task db:rebuild-stats:remote` (przelicza statystyki i liczniki limitów z tabeli `reports`).
- Podgląd danych: `npx wrangler d1 execute hulajdusza --remote --command "SELECT operator, COUNT(*) FROM reports GROUP BY operator"`.
- Cofnięcie wersji Workera: `npx wrangler rollback`.
- Historia bazy (D1 Time Travel): `npx wrangler d1 time-travel info hulajdusza`.

## 12. Najczęstsze problemy

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| Widget Turnstile pokazuje błąd (np. 110200) | host nie jest na liście w widgecie (krok 3) albo site key nie pasuje do sekretu |
| `turnstile_failed` przy wysyłce | zły `TURNSTILE_SECRET` (ustaw ponownie krok 3) |
| `no such table: ...` | nie wykonano `schema.sql` na bazie `--remote` (krok 2) |
| Zdjęcie ma kod QR, a aplikacja go nie czyta | przeglądarka czyta kod sama: zrób zdjęcie bliżej i ostro, albo użyj „Zeskanuj” / „Wpisz ręcznie” |
| `mail failed ... 401` | brak lub zły `RESEND_API_KEY` |
| Mail idzie, ale trafia do spamu | brak rekordów SPF/DKIM lub domena niezweryfikowana |
| Kamera/GPS nie działają | strona otwarta po HTTP; wymagany HTTPS |
| Po zmianie kolorów/operatorów stare dane na stronie | `/api/config` jest cache'owany 60 s |
| `quota_daily` / komunikat o limicie | wyczerpany `DAILY_LIMIT`; podnieś zmienną lub poczekaj do północy UTC |

## 13. Przed publicznym uruchomieniem: warto wiedzieć

- Interfejs używa Tailwind przez CDN (`cdn.tailwindcss.com`). Konsola przeglądarki ostrzega, że to nie jest zalecane na produkcji. Działa, ale docelowo warto zbudować CSS.
- Adres na podstawie GPS pochodzi z Nominatim (OpenStreetMap), który ma limit ok. 1 zapytania na sekundę i wymaga rozsądnego użycia. Przy większym ruchu potrzebny będzie własny geokoder.
- Mapa korzysta z darmowych kafelków OpenFreeMap. Bez klucza, ale bez gwarancji SLA.
- Poza Turnstile i limitami dziennymi/miesięcznymi nie ma limitu na IP. Jeśli pojawi się nadużycie, dodaj Cloudflare Rate Limiting dla `/api/report` (wysyła maile, więc jest najdroższy).
- Sprzątanie starych wpisów (`reported_scooters`, `quota_usage`, `stats_hourly`) odbywa się przy okazji udanych zgłoszeń. Nie ma osobnego crona.
- Żadnych sekretów nie wpisuj do `wrangler.jsonc` (jest w repozytorium). Sekrety ustawiaj przez `wrangler secret put`. Lokalny plik `.dev.vars` jest w `.gitignore`.

## Lista kontrolna

- [ ] `npm install`, `wrangler login`
- [ ] `d1 create`, `database_id` w `wrangler.jsonc`, `schema.sql` na `--remote`
- [ ] Turnstile: widget z hostem, `TURNSTILE_SITE_KEY` w pliku, `TURNSTILE_SECRET` jako sekret
- [ ] `HASH_SECRET` jako sekret (losowe 32 bajty)
- [ ] `FROM_EMAIL` na własnej domenie
- [ ] Wariant A (Paid + Email Service) albo B (Resend, plan Free)
- [ ] `deploy` w trybie `EMAIL_DRY_RUN="true"` i test na telefonie
- [ ] Test wysyłki na własny adres, potem `EMAIL_DRY_RUN="false"`
- [ ] Potwierdzone adresy operatorów
