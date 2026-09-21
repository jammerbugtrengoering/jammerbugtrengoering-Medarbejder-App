# Worklist — læs det her, før du retter noget

Medarbejderappen. Den kører på telefonen i lommen på en, der står i en fremmed entré med
handsker på. Det er den målestok, alt skal holdes op imod.

Det her er den eneste fil, en Claude læser af sig selv. Den lange baggrund ligger i
`Planning-App/overdragelse/` — et **andet repository**, som ikke nødvendigvis er hentet
ned på den maskine, du sidder ved. Derfor står det vigtigste her.

Appen er i drift. Netlify lægger ud, så snart der er pushet.

---

## Skal altid virke på både Android og iOS

Medarbejderne er cirka ligeligt fordelt. **Enhver ændring skal vurderes mod begge**, før
den meldes færdig — og kan noget kun afprøves det ene sted, skal det siges højt frem for
at antages.

«Det virker på Nadines iPhone» er ikke et svar.

**Push-beskeder.** På iPhone virker de kun, når appen ligger på hjemmeskærmen; en fane i
Safari får ingenting, og det er Apples regel. På Android virker de i Chrome uden videre.
Vis aldrig en knap, der ikke kan holde, hvad den lover.

**Tastatur og skærmhøjde.** Både iOS og Android (siden Chrome 108) bruger
`resizes-visual`: layout-viewporten krymper **ikke**, når tastaturet åbner, så alt med
`position: fixed` og `inset: 0` bliver dækket. Brug `useSynligHoejde()`, som måler
`visualViewport`. Det var derfor «Afslut opgaven» blev klippet over.

**Emoji i knapper.** Android tegner emoji med Noto, iOS med Apple Color Emoji, og de er
ikke lige brede. En bjælke, der passer på iPhone, kan løbe over på Android. Brug
lucide-ikoner i felter med fast bredde.

**Sikker zone.** `env(safe-area-inset-*)` er reelle tal på iPhone og som regel nul på
Android. Appen kører med `viewport-fit=cover`, så fuldskærmssider skal bruge dem i top og
bund.

**Systemskrifttyper.** Store skriftstørrelser er mere udbredt på Android. Faste højder på
knapper og blokke skal kunne rumme det.

**Ny version.** Service workeren kører `registerType: "prompt"` med `skipWaiting: false` —
med vilje, så en opdatering aldrig overtager midt i en tidsregistrering. Prisen er, at
telefonen skal lukkes helt ned. På iPhone betyder det at skubbe appen væk i
app-skifteren; at skifte til en anden app er ikke nok. Husk det, før en «fejl» meldes som
ikke rettet.

---

## Skriften er et valg, ikke en smagssag

Nogle af medarbejderne er ordblinde. Det her er truffet med dem for øje og skal ikke
rulles tilbage, fordi noget ser «luftigt» ud:

- **Venstrestillet.** Aldrig centreret brødtekst.
- **Linjeafstand mindst 1,5** (`font: 18px/155%` i `index.css`). Ligger linjerne tæt,
  glider øjet ned i den forkerte på vej tilbage, og sætningen skal læses forfra.
- **Ingen ord med STORE BOGSTAVER.** Versaler fjerner ordets form, og formen er det, en
  ordblind læser genkender. Derfor er `textTransform: "uppercase"` fjernet fra
  overskrifterne.
- **Brækhvid baggrund** (`PAPIR = "#FDFCF8"`) frem for skarp hvid.

> `#root { text-align: center }` stod i Vite-skabelonen og centrerede hver eneste tekst i
> appen. `text-align` nedarves, så det ramte alt og var ikke til at se i koden ét sted.
> Den linje skal blive ved at hedde `left`.

---

## Fælder, der har kostet tid

**`function top()` på øverste niveau kolliderer med `window.top`.** Den er ikke skrivbar,
og siden dør før første tegning — uden fejl i konsollen, du kan bruge til noget. Gælder
også `name`, `status`, `length`, `origin`, `closed`, `parent`.

**Service workeren kaprer alle navigationer.** `NavigationRoute` med
`createHandlerBoundToURL("/index.html")` betyder, at enhver sti serverer appen — også
`/proev.html`. Nye selvstændige sider i `public/` skal med i denylisten i `src/sw.js`,
ellers får brugeren appen i stedet for siden.

**Prøvedagen (`public/proev.html`)** er en kopi. Rettes øvelsen i `~/planapp`, skal den
kopieres herind igen, ellers er det den gamle, medarbejderne øver sig på.

---

## Når I er flere om det samme repository

**Sæt de her én gang på hver maskine:**

    git config --global pull.rebase false
    git config --global user.name "Fornavn Efternavn"
    git config --global user.email "din@adresse.dk"

Uden den første siger git *«You have divergent branches»* og **gør ingenting**. Uden de to
andre står der «Dit Navn» i historikken.

Bliver et push afvist med `(fetch first)`, har den anden pushet imens:

    git pull --no-rebase --no-edit origin main
    git push origin main

Kommer der **CONFLICT**, så stop. Brug aldrig `--force`. `git merge --abort` sætter dig
tilbage.

---

## Faste ting

- **Hjælpen skal opdateres, når funktionalitet ændres** — både `HELP_DA` og `HELP_EN`.
  De to skal have lige mange afsnit. En hjælpetekst, der ikke længere passer, er værre
  end ingen.
- **Kommentarer forklarer hvorfor, ikke hvad** — og gerne hvilken fejl der ligger bag.
- Privatlivsteksten («Dine personoplysninger») skal rettes, når databasen begynder at
  gemme noget nyt om medarbejderen. Den findes på dansk **og** engelsk.
- Solsikken (`medSolsikke`) er pynt og må aldrig nå data.

## Før du melder noget færdigt

    npm run build

Den kører selv `oxlint`, `tjek-tdz.mjs`, `ugespring.test.mjs` og `tidsfelt.test.mjs`. Går
en af dem i stykker, bygger den ikke — det er med vilje.

Claude kan ikke nå GitHub. **Claude retter og committer, brugeren pusher.** Slut svaret af
med kommandoen:

    cd ~/planapp/jammerbugtrengoering-Medarbejder-App && git push origin main
