// Tests af ugeregningen. Køres ved hvert build.
//
// Hvorfor det er værd at teste: planen henter én uge ad gangen. Regner springet
// forkert, får medarbejderen en ANDEN uges opgaver at se — uden fejlmeddelelse,
// uden at noget ser forkert ud. Hun ville køre efter en liste, der ikke var hendes.
//
// Alle prøver giver «i dag» med som argument. Ellers ville testen bestå eller fejle
// afhængigt af, hvilken ugedag nogen tilfældigvis kørte den.

import { isoWeekInfo, weekInfoWithOffset, isoMandag, ugerFraNu } from "./src/uger.js";

let fejl = 0, koert = 0;
function er(hvad, faktisk, forventet) {
  koert++;
  const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
  if (a !== b) {
    fejl++;
    console.error(`  ✗ ${hvad}\n      fik       ${a}\n      forventet ${b}`);
  }
}
const dag = (a, m, d) => new Date(a, m - 1, d);

// ── Almindelige uger ────────────────────────────────────────────────────────
const fredag11sep = dag(2026, 9, 11);
er("11. september 2026 er uge 37", isoWeekInfo(fredag11sep), { week: 37, year: 2026 });

// Nadines efterslæb, som listen skal kunne springe hen til.
er("tre uger tilbage", ugerFraNu(2026, 34, fredag11sep), -3);
er("to uger tilbage",  ugerFraNu(2026, 35, fredag11sep), -2);
er("en uge tilbage",   ugerFraNu(2026, 36, fredag11sep), -1);
er("denne uge",        ugerFraNu(2026, 37, fredag11sep), 0);
er("næste uge",        ugerFraNu(2026, 38, fredag11sep), 1);

// Springet og opslaget skal være hinandens modsætning. Er de ikke det, henter
// planen en anden uge, end den listen troede, den bad om.
for (const uge of [30, 34, 37, 40, 52]) {
  er(`spring og opslag passer sammen, uge ${uge}`,
     weekInfoWithOffset(ugerFraNu(2026, uge, fredag11sep), fredag11sep),
     { week: uge, year: 2026 });
}

// ── Sommertid ───────────────────────────────────────────────────────────────
// Danmark skifter sidste søndag i marts og i oktober. Mellem to mandage hen over
// skiftet er der 7 døgn minus eller plus en time. Uden afrundingen i ugerFraNu
// ville springet lande én uge forkert — og hun ville få en forkert uge at se.
const tirsdag20okt = dag(2026, 10, 20);           // uge 43; skiftet er 25. oktober
er("hen over efterårsskiftet", ugerFraNu(2026, 44, tirsdag20okt), 1);
er("to uger hen over det",     ugerFraNu(2026, 45, tirsdag20okt), 2);
const tirsdag24mar = dag(2026, 3, 24);            // uge 13; skiftet er 29. marts
er("hen over forårsskiftet",   ugerFraNu(2026, 14, tirsdag24mar), 1);
er("og tilbage igen",          ugerFraNu(2026, 13, dag(2026, 3, 31)), -1);

// ── Årsskiftet ──────────────────────────────────────────────────────────────
// 2026 er et 53-ugers år. Det er her ugenumre plejer at gå galt: uge 53 findes,
// og 1. januar 2027 hører til den.
er("2026 har en uge 53", isoWeekInfo(dag(2026, 12, 31)), { week: 53, year: 2026 });
er("1. januar 2027 hører til 2026", isoWeekInfo(dag(2027, 1, 1)), { week: 53, year: 2026 });
const tirsdag22dec = dag(2026, 12, 22);           // uge 52
er("frem til uge 53",        ugerFraNu(2026, 53, tirsdag22dec), 1);
er("frem i det nye år",      ugerFraNu(2027, 1, tirsdag22dec), 2);
er("tilbage over skiftet",   ugerFraNu(2026, 53, dag(2027, 1, 12)), -2);
er("uge 30 i 2027 er ikke uge 30 i 2026",
   ugerFraNu(2027, 30, fredag11sep) === ugerFraNu(2026, 30, fredag11sep), false);

// De to dage om året hvor kalenderåret og ISO-året IKKE er det samme. Her skal
// «year» følge ugen og ikke datoen — ellers spørger planen efter uge 53 i 2027,
// som ikke findes, og hun får en tom dag at se på.
//
// Prøverne ovenfor fanger det ikke: de ligger alle midt i året, hvor de to tal er
// ens. Den fejl slap igennem en hel testrunde, før den her linje kom til.
er("1. januar 2027 hører til uge 53 i 2026",
   weekInfoWithOffset(0, dag(2027, 1, 1)), { week: 53, year: 2026 });
er("30. december 2025 hører til uge 1 i 2026",
   weekInfoWithOffset(0, dag(2025, 12, 30)), { week: 1, year: 2026 });
er("og springet derfra rammer uge 2 i 2026",
   weekInfoWithOffset(1, dag(2025, 12, 30)), { week: 2, year: 2026 });

// ── Mandagen i en uge ───────────────────────────────────────────────────────
er("mandag i uge 1, 2026",  isoMandag(2026, 1).toDateString(),  dag(2025, 12, 29).toDateString());
er("mandag i uge 37, 2026", isoMandag(2026, 37).toDateString(), dag(2026, 9, 7).toDateString());
er("mandag i uge 53, 2026", isoMandag(2026, 53).toDateString(), dag(2026, 12, 28).toDateString());
er("mandag i uge 1, 2027",  isoMandag(2027, 1).toDateString(),  dag(2027, 1, 4).toDateString());

// ── Resultat ────────────────────────────────────────────────────────────────
if (fejl > 0) {
  console.error(`\n  ${fejl} af ${koert} kontroller fejlede i ugeregningen.\n`);
  process.exit(1);
}
console.log(`Ugespring: ${koert} kontroller i orden.`);
