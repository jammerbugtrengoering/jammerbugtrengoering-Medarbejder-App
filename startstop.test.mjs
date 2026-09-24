// Proever reglerne for start/stop (src/startstop.js).
//
// Det vigtigste: en medarbejder uden start/stop maa aldrig mærke noget, en telefon
// uden position maa aldrig spaerre, og automatisk start kun naar det er entydigt.
import {
  afstandMeter, egenTid, brugerStartStop, vurderStart, kanAutoStarte, iTidsvindue,
  autoStartKandidat, maaltMin, kraeverBegrundelse, stolPaaOpslag, formatAfstand,
  LANGT_VAEK_M, VED_ADRESSEN_M,
} from "./src/startstop.js";

let fejl = 0, ok = 0;
function er(navn, faktisk, forventet) {
  const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
  if (a === b) { ok++; return; }
  fejl++; console.error(`FEJL: ${navn}\n      fik      ${a}\n      forventet ${b}`);
}

const TIL = { startStop: true, graense: 60 };
const FRA = { startStop: false, graense: 60 };
const stor = { id: "a", duration: 90, scheduled_time: "09:00:00" };
const lille = { id: "b", duration: 45, scheduled_time: "11:00:00" };

// ---- Porten ----
er("slaaet fra: aldrig, heller ikke paa en stor opgave", brugerStartStop(FRA, stor, "e1"), false);
er("ingen regel hentet: aldrig", brugerStartStop(null, stor, "e1"), false);
er("slaaet til, stor opgave", brugerStartStop(TIL, stor, "e1"), true);
er("slaaet til, lille opgave: den gamle maade", brugerStartStop(TIL, lille, "e1"), false);
er("praecis paa graensen taeller med", brugerStartStop(TIL, { duration: 60 }, "e1"), true);
er("hendes andel afgoer, ikke opgavens varighed",
  brugerStartStop(TIL, { duration: 120, tidFordeling: { e1: 40, e2: 80 } }, "e1"), false);
er("kollegaens andel er over", brugerStartStop(TIL, { duration: 120, tidFordeling: { e1: 40, e2: 80 } }, "e2"), true);
er("egen tid uden fordeling", egenTid(stor, "e1"), 90);

// ---- Start herfra? ----
er("ingen position: maa starte", vurderStart(null, null), "ukendt");
er("ved doeren", vurderStart(20, 15), "ok");
er("paa vejen, 3 km vaek", vurderStart(3000, 30), "vaek");
er("langt, men usikkerheden er stoerre: ikke spaerret", vurderStart(900, 1000), "ok");
er("lige paa graensen", vurderStart(LANGT_VAEK_M, 0), "ok");
er("lige over", vurderStart(LANGT_VAEK_M + 1, 0), "vaek");

// ---- Automatisk start ----
er("taet og praecis", kanAutoStarte(30, 20), true);
er("taet men upraecis", kanAutoStarte(30, 400), false);
er("praecis men for langt", kanAutoStarte(VED_ADRESSEN_M + 1, 10), false);
er("uden position aldrig automatisk", kanAutoStarte(null, null), false);

const kl = (t) => { const d = new Date(2026, 8, 24); const [h, m] = t.split(":"); d.setHours(+h, +m, 0, 0); return d; };
er("30 min foer: i vinduet", iTidsvindue(stor, "e1", kl("08:30")), true);
er("31 min foer: ikke", iTidsvindue(stor, "e1", kl("08:29")), false);
er("en time efter planlagt slut: stadig", iTidsvindue(stor, "e1", kl("11:30")), true);
er("uden tidspunkt: hele dagen", iTidsvindue({ duration: 90 }, "e1", kl("16:00")), true);

const ved = { a: { afstand: 20, noejagtighed: 15 } };
const basis = { opgaver: [stor, lille], empId: "e1", regel: TIL, startede: {}, afstande: ved, nu: kl("08:50"), allerede: new Set() };
er("én stor opgave ved doeren", autoStartKandidat(basis)?.id, "a");
er("slaaet fra: intet", autoStartKandidat({ ...basis, regel: FRA }), null);
er("hun har en tid koerende: intet", autoStartKandidat({ ...basis, startede: { x: {} } }), null);
er("fortrudt i dag: startes ikke igen", autoStartKandidat({ ...basis, allerede: new Set(["a"]) }), null);
er("afsluttet: intet", autoStartKandidat({ ...basis, opgaver: [{ ...stor, completed_by_employee: { e1: "x" } }] }), null);
er("to kandidater samme sted: intet (ikke entydigt)",
  autoStartKandidat({ ...basis, opgaver: [stor, { ...stor, id: "c" }], afstande: { ...ved, c: { afstand: 10, noejagtighed: 10 } } }), null);
er("for tidligt: intet", autoStartKandidat({ ...basis, nu: kl("07:00") }), null);

// ---- Maalt tid og begrundelse ----
er("maalt", maaltMin(0, 38 * 60000 + 20000), 38);
er("negativ bliver nul", maaltMin(1000, 0), 0);
er("uden start ingen maaling", maaltMin(null, 5), null);
er("2 min rettet: ok", kraeverBegrundelse(40, 38), false);
er("3 min rettet: skriv hvorfor", kraeverBegrundelse(41, 38), true);
er("ned er ogsaa en rettelse", kraeverBegrundelse(30, 38), true);
er("uden maaling: den gamle regel", kraeverBegrundelse(60, null), false);

// ---- Afstand ----
er("to punkter ca. 5,7 km", Math.round(afstandMeter({ lat: 57.21193321, lon: 9.5230701 }, { lat: 57.24519452, lon: 9.61151527 }) / 100), 65);
er("samme punkt", afstandMeter({ lat: 57, lon: 9 }, { lat: 57, lon: 9 }), 0);

er("afstand i meter", formatAfstand(42), "42 m");
er("afstand i km", formatAfstand(3400), "3,4 km");

// ---- Tillid til adresseopslaget ----
const fund = { vejnavn: "Bakkevej", husnr: "17", postnr: "9492" };
er("samme adresse", stolPaaOpslag("Bakkevej 17, 9492 Blokhus", fund), true);
er("andet husnummer", stolPaaOpslag("Bakkevej 171, 9492 Blokhus", fund), false);
er("andet postnummer", stolPaaOpslag("Bakkevej 17, 9440 Aabybro", fund), false);
er("anden vej", stolPaaOpslag("Bakkegade 17, 9492 Blokhus", fund), false);
er("17A er ikke 17", stolPaaOpslag("Bakkevej 17A, 9492 Blokhus", fund), false);
er("intet fund", stolPaaOpslag("Bakkevej 17, 9492 Blokhus", null), false);

console.log(fejl ? `\nStart/stop: ${fejl} fejlede, ${ok} i orden.` : `Start/stop: ${ok} kontroller i orden.`);
process.exit(fejl ? 1 : 0);
