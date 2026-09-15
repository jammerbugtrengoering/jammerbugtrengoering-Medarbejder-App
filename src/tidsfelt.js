// Timer og minutter på afslutningsskærmen — regnestykket bag de to felter.
//
// Der er ÉT tal bagved: samletMin. Timer og minutter er to visninger af det samme,
// ikke to tilstande. Med to tilstande skal 55 + 5 både nulstille minutterne og
// lægge en time til, og de to kan komme i utakt — det er dén fejl, der blev lukket
// dengang vælgeren blev lavet om til ét tal, og den skal blive lukket.
//
// Knapperne går i spring af fem, fordi det er det almindelige. Men tallene kan
// også skrives: 18 minutter skal kunne registreres. Kunne de ikke det, måtte
// medarbejderen skrive 20, og så blev både hendes løn og kundens regning regnet
// på noget, der ikke var sket.
//
// Ændrer du noget her, så ret tidsfelt.test.mjs i samme ombæring.

export const MAKS_MIN = 12 * 60;   // Samme loft som den gamle timevælger.

function begraens(min) {
  return Math.max(0, Math.min(MAKS_MIN, Math.round(min)));
}

// − og + knapperne.
export function skiftTid(samletMin, delta) {
  return begraens((Number(samletMin) || 0) + delta);
}

// Timefeltet. Minutterne bliver stående — retter hun timerne, er det kun timerne,
// hun mener.
export function saetTimer(samletMin, vaerdi) {
  const nu = Number(samletMin) || 0;
  // Et tomt felt er 0 og ikke NaN: hun sletter tallet for at skrive et nyt, og
  // midt i det er feltet tomt et øjeblik.
  const t = Math.max(0, Math.min(12, Math.floor(Number(vaerdi) || 0)));
  return begraens(t * 60 + (nu % 60));
}

// Minutfeltet. Det er minutterne i timen, ikke tiden i alt — men skriver hun 75,
// er det rigtige svar 1t 15m og ikke et loft på 59. Hun mente 75 minutter.
export function saetMinutter(samletMin, vaerdi) {
  const nu = Number(samletMin) || 0;
  const raa = Math.max(0, Math.floor(Number(vaerdi) || 0));
  const t = Math.floor(nu / 60) + Math.floor(raa / 60);
  return begraens(t * 60 + (raa % 60));
}
