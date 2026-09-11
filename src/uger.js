// Ugeregning. Ligger for sig selv, fordi den kan tage fejl uden at sige noget.
//
// Planen henter én uge ad gangen — `eq("week", ...)` og `eq("year", ...)`. Regner
// noget her forkert, faar medarbejderen en forkert uges opgaver at se, uden at
// nogen fejl bliver vist nogen steder. Det er den slags, der bliver opdaget af en
// borger, der ikke fik besoeg.
//
// De to steder, hvor det historisk gaar galt, er aarsskiftet og sommertid. Begge
// er daekket af ugespring.test.mjs, som koeres ved hvert build. Retter du noget
// her, saa ret testen i samme ombaering.

// Beregner både ISO-ugenummer OG det år ugen hører til. Omkring årsskiftet kan
// de to afvige (30. dec. kan høre til uge 1 i det nye år), og da planlæggeren
// gemmer både week og year på hver opgave, SKAL vi matche på begge — ellers
// blandes fx uge 30 i 2026 sammen med uge 30 i 2027.
export function isoWeekInfo(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNum = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNum + 3); // Nærmeste torsdag afgør ISO-uge-året
  const isoYear = d.getFullYear();
  const yearStart = new Date(isoYear, 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week, year: isoYear };
}

// Finder (uge, år) et antal uger fra i dag. Regner i rigtige 7-dages spring over
// kalenderen, så navigation forbi uge 52/53 ruller korrekt over til det nye år
// i stedet for at give ugyldige ugenumre som 53, 54, 55...
export function weekInfoWithOffset(offset, idag = new Date()) {
  const d = new Date(idag.getFullYear(), idag.getMonth(), idag.getDate());
  d.setDate(d.getDate() + offset * 7);
  return isoWeekInfo(d);
}

// Mandagen i en given ISO-uge. 4. januar ligger altid i uge 1 — det er selve
// definitionen af ISO-uger, og derfor det eneste holdbare udgangspunkt. At regne
// fra 1. januar giver et døgns fejl i omtrent halvdelen af årene.
export function isoMandag(aar, uge) {
  const d = new Date(aar, 0, 4);
  const dagNr = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dagNr + (uge - 1) * 7);
  return d;
}

// Hvor mange uger frem eller tilbage ligger (aar, uge) i forhold til i dag?
//
// Bruges når hun trykker på en manglende opgave fra en anden uge: planen henter
// én uge ad gangen, så vi skal give den det rigtige spring.
//
// Math.round og ikke en heltalsdivision: mellem to mandage kan der ligge et
// sommertidsskifte, og så er forskellen 7 døgn minus en time. Uden afrundingen
// ville springet hen over den weekend i marts og oktober lande én uge forkert.
export function ugerFraNu(aar, uge, idag = new Date()) {
  const nu = isoWeekInfo(idag);
  return Math.round((isoMandag(aar, uge) - isoMandag(nu.year, nu.week)) / (7 * 86400000));
}
