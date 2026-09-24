// Start/stop — reglerne, samlet ét sted og uden skaerm, saa de kan proeves.
//
// 24.9.2026, bestemt af Jonn: store opgaver (fra en graense, standard 60 min) maales
// med Start og Afslut, for medarbejdere der har faaet det slaaet til. Alle andre —
// og alle mindre opgaver — registrerer praecis som hidtil.
//
// Det, der ikke maa gaa galt:
//   * En medarbejder UDEN start/stop maa aldrig se noget af det. brugerStartStop()
//     er den eneste port, og den siger nej, hvis regel.startStop ikke er sand.
//   * Start maa ikke kunne trykkes paa vejen fra forrige kunde. Men en telefon
//     uden position maa ALDRIG spaerre — kaelder, daarligt signal, afvist tilladelse.
//     Saa maa hun starte, og det bliver noteret.
//   * Automatisk start kun naar det er helt entydigt: én opgave, i tidsvinduet,
//     taet paa, og en position der er praecis nok til at sige det.
//   * Positionen gemmes aldrig. Kun afstanden i hele meter.
//
// Aendrer du noget her, saa ret startstop.test.mjs i samme ombaering.

// Inden for denne afstand staar hun ved adressen, og tiden kan starte af sig selv.
export const VED_ADRESSEN_M = 75;
// Over denne afstand — ogsaa naar usikkerheden er trukket fra — er hun et andet sted.
// Samme graense som markeringen paa Kundetimer i planlaegningsappen.
export const LANGT_VAEK_M = 150;
// En position med stoerre usikkerhed end det kan ikke bruges til automatisk start.
export const MAKS_USIKKERHED_AUTO_M = 100;
// Automatisk start tidligst saa mange minutter foer det planlagte tidspunkt.
export const FOER_START_MIN = 30;
// ... og senest saa mange minutter efter den planlagte slut.
export const EFTER_SLUT_MIN = 60;
// Retter hun den maalte tid med mere end det, skal hun skrive hvorfor. Samme tal
// som i databasens afslut_tid — de to skal foelges ad.
export const RET_GRAENSE_MIN = 2;

// Afstand i meter mellem to punkter (haversine). {lat, lon}.
export function afstandMeter(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// «42 m», «3,4 km». Samme form som paa Kundetimer i planlaegningsappen.
export function formatAfstand(m) {
  if (m === null || m === undefined || !Number.isFinite(Number(m))) return "?";
  const n = Number(m);
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toLocaleString("da-DK", { maximumFractionDigits: 1 })} km`;
}

// Hendes egen tid paa opgaven: hendes andel, hvis timerne er fordelt, ellers varigheden.
export function egenTid(task, empId) {
  const f = task?.tidFordeling || task?.tid_fordeling || {};
  const andel = Number(f[empId]);
  if (andel > 0) return Math.round(andel);
  return Number(task?.duration) || 0;
}

export function erFaerdig(task, empId) {
  return !!((task?.completed_by_employee || {})[empId]);
}

// Den ENE port. Siger nej til alt, hvis medarbejderen ikke har start/stop.
export function brugerStartStop(regel, task, empId) {
  if (!regel || regel.startStop !== true || !task || !empId) return false;
  const graense = Number(regel.graense) > 0 ? Number(regel.graense) : 60;
  return egenTid(task, empId) >= graense;
}

// Maa hun trykke Start herfra?
//   "ok"     - ved adressen, eller for usikkert til at sige andet
//   "vaek"   - tydeligt et andet sted, ogsaa naar usikkerheden er trukket fra
//   "ukendt" - ingen position. Start er tilladt, men det bliver noteret.
export function vurderStart(afstand, noejagtighed) {
  if (afstand === null || afstand === undefined || !Number.isFinite(Number(afstand))) return "ukendt";
  const usikker = Number.isFinite(Number(noejagtighed)) ? Math.max(0, Number(noejagtighed)) : 0;
  return Number(afstand) - usikker > LANGT_VAEK_M ? "vaek" : "ok";
}

// Taet nok paa, og sikkert nok, til at starte uden at hun trykker?
export function kanAutoStarte(afstand, noejagtighed) {
  if (afstand === null || afstand === undefined || !Number.isFinite(Number(afstand))) return false;
  if (noejagtighed === null || noejagtighed === undefined || !Number.isFinite(Number(noejagtighed))) return false;
  return Number(noejagtighed) <= MAKS_USIKKERHED_AUTO_M && Number(afstand) <= VED_ADRESSEN_M;
}

// "09:30" eller "09:30:00" -> minutter efter midnat. null hvis der ikke er et tidspunkt.
function minutterEfterMidnat(tid) {
  if (!tid) return null;
  const m = String(tid).match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Er vi i opgavens tidsvindue? Uden planlagt tidspunkt er hele dagen vinduet.
export function iTidsvindue(task, empId, nu) {
  const start = minutterEfterMidnat(task?.scheduled_time || task?.scheduledTime);
  if (start === null) return true;
  const n = nu.getHours() * 60 + nu.getMinutes();
  return n >= start - FOER_START_MIN && n <= start + egenTid(task, empId) + EFTER_SLUT_MIN;
}

// Hvilken opgave skal starte af sig selv lige nu? Svaret er én opgave eller null.
//
//   opgaver   - DAGENS opgaver (kalderen sorterer andre dage og uger fra)
//   startede  - { [opgaveId]: ... } for de opgaver hun har startet og ikke afsluttet
//   afstande  - { [opgaveId]: { afstand, noejagtighed } }
//   allerede  - Set med opgaver der er startet automatisk og fortrudt i dag. De
//               startes ikke igen — ellers kunne hun aldrig fortryde.
export function autoStartKandidat({ opgaver, empId, regel, startede, afstande, nu, allerede }) {
  // Har hun allerede en tid koerende, er hun i gang med noget. Saa starter vi
  // ikke en til bag hendes ryg — heller ikke hos naboen.
  if (Object.keys(startede || {}).length > 0) return null;
  const mulige = (opgaver || []).filter((t) =>
    brugerStartStop(regel, t, empId)
    && !erFaerdig(t, empId)
    && !(allerede && allerede.has(t.id))
    && iTidsvindue(t, empId, nu)
    && kanAutoStarte(afstande?.[t.id]?.afstand, afstande?.[t.id]?.noejagtighed));
  return mulige.length === 1 ? mulige[0] : null;
}

// Maalt tid i hele minutter.
export function maaltMin(startMs, nuMs) {
  if (startMs === null || startMs === undefined || !Number.isFinite(Number(startMs))) return null;
  return Math.max(0, Math.round((Number(nuMs) - Number(startMs)) / 60000));
}

export function kraeverBegrundelse(minutter, maalt) {
  if (maalt === null || maalt === undefined) return false;
  return Math.abs(Number(minutter) - Number(maalt)) > RET_GRAENSE_MIN;
}

// Kan vi stole paa, at registrets svar er DEN adresse, der staar paa opgaven?
// Autocomplete giver altid sit bedste bud — ogsaa naar det er et andet husnummer
// eller en anden by. Et forkert punkt ville spaerre Start ved den rigtige doer,
// saa hellere ingen koordinater end forkerte: uden dem er positionen «ukendt», og
// hun kan starte som altid.
export function stolPaaOpslag(adresse, fund) {
  if (!adresse || !fund) return false;
  const tekst = String(adresse).toLowerCase();
  const postnr = String(fund.postnr || "");
  const husnr = String(fund.husnr || "").toLowerCase();
  const vej = String(fund.vejnavn || "").toLowerCase();
  if (!postnr || !husnr || !vej) return false;
  if (!new RegExp(`\\b${postnr}\\b`).test(tekst)) return false;
  if (!tekst.includes(vej)) return false;
  return new RegExp(`(^|[^0-9])${husnr.replace(/[^0-9a-z]/g, "")}([^0-9a-z]|$)`).test(tekst);
}
