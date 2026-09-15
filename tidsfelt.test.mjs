// Tests af tidsfeltet på afslutningsskærmen. Køres ved hvert build.
//
// Hvad de beskytter mod: det tal, der kommer ud herfra, bliver til løn til
// medarbejderen og til en regning til kunden. Rammer det ved siden af, opdager
// ingen det — en time er en time, uanset om den er rigtig.
//
// 15.9.2026: minutterne kunne kun gå i spring af fem, så 18 minutter kunne ikke
// registreres. Nu kan tallene også skrives.

import { skiftTid, saetTimer, saetMinutter, MAKS_MIN } from "./src/tidsfelt.js";

let fejl = 0, koert = 0;
function er(hvad, faktisk, forventet) {
  koert++;
  if (JSON.stringify(faktisk) !== JSON.stringify(forventet)) {
    fejl++;
    console.error(`  ✗ ${hvad}\n      fik       ${JSON.stringify(faktisk)}\n      forventet ${JSON.stringify(forventet)}`);
  }
}
const vis = (m) => [Math.floor(m / 60), m % 60];

// ── Det, det hele handler om ────────────────────────────────────────────────
er("18 minutter kan skrives", saetMinutter(60, 18), 78);
er("og vises som 1t 18m",     vis(saetMinutter(60, 18)), [1, 18]);
er("7 minutter kan skrives",  saetMinutter(0, 7), 7);
er("1 minut kan skrives",     saetMinutter(0, 1), 1);

// ── Knapperne virker stadig ─────────────────────────────────────────────────
er("plus fem",            skiftTid(0, 5), 5);
er("plus en time",        skiftTid(5, 60), 65);
er("minus fem",           skiftTid(20, -5), 15);
// Fejlen fra dengang vælgeren havde to tilstande: 55 + 5 skal blive en hel time.
er("55 + 5 bliver 1t 00m", vis(skiftTid(55, 5)), [1, 0]);
// Og den vej tilbage igen.
er("1t 00m − 5 bliver 55m", vis(skiftTid(60, -5)), [0, 55]);

// ── De to felter skriver i det samme tal ────────────────────────────────────
er("timer rettes, minutterne bliver stående", vis(saetTimer(78, 3)), [3, 18]);
er("minutter rettes, timerne bliver stående", vis(saetMinutter(127, 45)), [2, 45]);
er("timer og derefter minutter", saetMinutter(saetTimer(0, 2), 7), 127);

// ── Randtilfælde ────────────────────────────────────────────────────────────
// Skriver hun 75 i minutfeltet, mente hun 75 minutter. Et loft på 59 ville
// stiltiende smide et kvarter væk.
er("75 minutter bliver 1t 15m", vis(saetMinutter(0, 75)), [1, 15]);
er("120 minutter bliver 2t",    vis(saetMinutter(0, 120)), [2, 0]);

// Et tomt felt midt i en indtastning må ikke give NaN — hun sletter tallet for
// at skrive et nyt, og midt i det er feltet tomt.
er("tomt minutfelt er nul minutter", saetMinutter(90, ""), 60);
er("tomt timefelt er nul timer",     saetTimer(90, ""), 30);
er("bogstaver er også nul",          saetMinutter(90, "abc"), 60);

// Loftet og bunden
er("loftet er 12 timer",              saetTimer(0, 99), MAKS_MIN);
er("loftet holder også fra minutterne", saetMinutter(700, 999) <= MAKS_MIN, true);
er("kan ikke gå under nul",           skiftTid(30, -60), 0);
er("negativ indtastning bliver nul",  saetMinutter(60, -5), 60);

// ── Resultat ────────────────────────────────────────────────────────────────
if (fejl > 0) {
  console.error(`\n  ${fejl} af ${koert} kontroller fejlede i tidsfeltet.\n`);
  process.exit(1);
}
console.log(`Tidsfelt: ${koert} kontroller i orden.`);
