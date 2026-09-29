// Firmaets navn, logo og farver — hentet fra Opsaetning -> Firma i stedet for at staa
// skrevet fast i koden (fase 1 af kundeloesningen, 29.9.2026).
//
// Den samme fil ligger i planlaegningsappen, Worklist og kundeportalen. Ret dem sammen.
//
// Tre ting, der ikke maa gaa galt:
//   * Jammerbugt Rengoering skal se praecis ud som foer. STANDARD er jeres vaerdier, og
//     farvevariablerne har jeres eksakte nuancer, saa lange hovedfarven er #D6247A.
//   * Intet maa blinke eller staa tomt. Sidste kendte vaerdier ligger paa enheden og
//     bruges straks; databasen opdaterer dem bagefter.
//   * Mails og udskrifter bruger IKKE farvevariablerne. En mail eller et nyt vindue kender
//     ikke appens CSS, saa der ville farven forsvinde. Brug farveHex() dér.

import { useEffect, useState } from "react";

// VITE_UDGAVE=kunde saettes paa de Netlify-sites, der koerer mod kundedatabasen. Saa er
// udgangspunktet neutralt (foer login ved vi ikke, hvilket firma det er). Uden variablen
// er det Jammerbugt Rengoering, praecis som foer.
export const KUNDEUDGAVE = import.meta.env?.VITE_UDGAVE === "kunde";

const STANDARD = KUNDEUDGAVE ? {
  navn: "Planlægning",
  undertekst: "",
  app_navn: "Planlægning",
  juridisk_navn: "",
  cvr: "",
  telefon: null,
  logo_url: null,
  hovedfarve: "#2563EB",
  menu_tema: "lys",
  modul_start_stop: true,
  modul_lager: true,
  modul_tilbud: true,
  // Kundeudgaven tilbyder ingen portal til firmaets egne kunder (Jonn 29.9.2026).
  modul_kundeportal: false,
  modul_dinero: false,
  modul_nexus: false,
} : {
  navn: "Jammerbugt Rengøring",
  undertekst: "Planlægning og fakturering",
  app_navn: "Rengøringsplan",
  juridisk_navn: "Jammerbugt Rengøring ApS",
  cvr: "41911387",
  telefon: null,
  logo_url: null,
  hovedfarve: "#D6247A",
  menu_tema: "moerk",
  // Hos Jammerbugt Rengoering er alle moduler med. Hos en kunde er det de koebte.
  modul_start_stop: true,
  modul_lager: true,
  modul_tilbud: true,
  modul_kundeportal: true,
  modul_dinero: true,
  modul_nexus: true,
};

// Er modulet med? Ukendt = med, saa intet forsvinder, foer indstillingerne er hentet.
// Databasen haandhaever det alligevel: det her styrer kun, hvad der VISES.
export function harModul(navn) {
  return FIRMA["modul_" + navn] !== false;
}

// Kundeudgaven har sin egen noegle, saa en browser, der har vaeret paa begge, ikke
// blander dem sammen.
const NOEGLE = KUNDEUDGAVE ? "firma_kunde_v1" : "firma_v1";

function laesCache() {
  try { return JSON.parse(localStorage.getItem(NOEGLE) || "null") || {}; } catch { return {}; }
}

// Kan bruges overalt, ogsaa uden for React (hjaelpetekster, konstanter, mails).
export const FIRMA = { ...STANDARD, ...laesCache() };

const lyttere = new Set();

// Hvilket felt fanebladets titel skal vise. Planlaegningsappen: app_navn. Kundeportalen:
// navn. Worklist hedder Worklist og saetter ingen.
let titelFelt = null;
export function brugTitel(felt) {
  titelFelt = felt;
  if (typeof document !== "undefined" && FIRMA[felt]) document.title = FIRMA[felt];
}

// ── Farver ──────────────────────────────────────────────────────────────────
// Jammerbugts egne nuancer, ikke udregnede: de skal vaere de samme som foer, pixel for pixel.
const JR_NUANCER = { farve: "#D6247A", moerk: "#9C1B5D", lys: "#FCE4EF", bleg: "#FFF6FA" };

function blandMed(hex, med, andel) {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const m = [1, 3, 5].map((i) => parseInt(med.slice(i, i + 2), 16));
  return "#" + n.map((v, i) => Math.round(v + (m[i] - v) * andel).toString(16).padStart(2, "0")).join("");
}

export function nuancer(hovedfarve) {
  const h = /^#[0-9A-Fa-f]{6}$/.test(hovedfarve || "") ? hovedfarve.toUpperCase() : JR_NUANCER.farve;
  if (h === JR_NUANCER.farve) return JR_NUANCER;
  return { farve: h, moerk: blandMed(h, "#000000", 0.27), lys: blandMed(h, "#FFFFFF", 0.87), bleg: blandMed(h, "#FFFFFF", 0.96) };
}

// Til mails og udskrifter, hvor CSS-variabler ikke virker.
export function farveHex(slags = "farve") {
  return nuancer(FIRMA.hovedfarve)[slags];
}

function saetVariabler() {
  if (typeof document === "undefined") return;
  const n = nuancer(FIRMA.hovedfarve);
  const r = document.documentElement.style;
  r.setProperty("--farve", n.farve);
  r.setProperty("--farve-moerk", n.moerk);
  r.setProperty("--farve-lys", n.lys);
  r.setProperty("--farve-bleg", n.bleg);
  const lysMenu = FIRMA.menu_tema === "lys";
  r.setProperty("--menu-bg", lysMenu ? "#FFFFFF" : "#111111");
  r.setProperty("--menu-tekst", lysMenu ? "#111111" : "#FFFFFF");
  r.setProperty("--menu-dim", lysMenu ? "#64748B" : "#D9A9C0");
  r.setProperty("--menu-sub", lysMenu ? n.moerk : "#E8AFC9");
  r.setProperty("--menu-kant", lysMenu ? "#E2E8F0" : "#333333");
}

saetVariabler();

// Hentes én gang pr. opstart. Virker ogsaa foer login (firma_offentlig er aaben for alle,
// og den giver kun det, en login-skaerm maa vise).
let hentet = null;
export function hentFirma(supabase) {
  if (hentet) return hentet;
  hentet = (async () => {
    try {
      const { data, error } = await supabase.rpc("firma_offentlig");
      const raekke = Array.isArray(data) ? data[0] : data;
      if (error || !raekke) return FIRMA;
      opdaterFirma(raekke);
    } catch { /* de sidst kendte vaerdier bliver staaende */ }
    return FIRMA;
  })();
  return hentet;
}

// Foer login i kundeudgaven: det korte navn i adressen (/hansen) giver firmaets navn,
// logo og farve paa login-skaermen. Efter login overtager firma_offentlig.
export async function hentFirmaEfterSlug(supabase, slug) {
  if (!KUNDEUDGAVE || !slug) return;
  try {
    const { data } = await supabase.rpc("firma_efter_slug", { p_slug: slug });
    const raekke = Array.isArray(data) ? data[0] : data;
    if (raekke) opdaterFirma(raekke);
  } catch { /* det neutrale udseende bliver staaende */ }
}

// Det korte navn = foerste led i adressen, hvis det ligner et.
export function slugFraAdresse() {
  if (typeof window === "undefined") return "";
  const m = window.location.pathname.match(/^\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/);
  return m ? m[1] : "";
}

// Efter login: hent igen. Foer login kender kundedatabasen ikke firmaet, saa det foerste
// svar var tomt.
export function genhentFirma(supabase) {
  hentet = null;
  return hentFirma(supabase);
}

// Kaldes ogsaa, naar Firma-siden er gemt, saa alt skifter med det samme.
export function opdaterFirma(raekke) {
  for (const k of Object.keys(STANDARD)) {
    if (raekke[k] !== undefined) FIRMA[k] = raekke[k] ?? STANDARD[k];
  }
  // Tomme tekstfelter falder tilbage til standard, saa en overskrift aldrig er tom.
  for (const k of ["navn", "app_navn"]) if (!FIRMA[k]) FIRMA[k] = STANDARD[k];
  try { localStorage.setItem(NOEGLE, JSON.stringify(FIRMA)); } catch { /* fuldt lager */ }
  saetVariabler();
  if (titelFelt && typeof document !== "undefined") document.title = FIRMA[titelFelt] || document.title;
  lyttere.forEach((f) => f({ ...FIRMA }));
}

// React: const firma = useFirma(supabase)
export function useFirma(supabase) {
  const [f, setF] = useState({ ...FIRMA });
  useEffect(() => {
    lyttere.add(setF);
    if (supabase) hentFirma(supabase);
    return () => { lyttere.delete(setF); };
  }, [supabase]);
  return f;
}
