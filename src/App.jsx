import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { weekInfoWithOffset, ugerFraNu } from "./uger";
import { skiftTid, saetTimer, saetMinutter } from "./tidsfelt";
import {
  Clock, CheckCircle2, Video, Lock, ListChecks, Check,
  Navigation, Building2, Car, ChevronLeft, ChevronRight,
  X, MapPin, Key,
  // Ikoner og ikke emoji i topbjaelken. Emoji tegnes af telefonens eget saet, og
  // Androids Noto er bredere end Apples — bjaelken kan altsaa passe paa en iPhone
  // og loebe over paa en Android uden at nogen har roert koden. Et ikon er lige
  // bredt overalt.
  CalendarPlus, Shirt, HelpCircle, AlertTriangle,
} from "lucide-react";

// ── Gemt kopi af ugens opgaver ───────────────────────────────────────────────
// Service workeren gemmer selve appen. Den her gemmer INDHOLDET, saa dagslisten kan
// tegnes i en kaelder uden daekning.
//
// Der ligger med vilje ingen adgangsoplysninger her. Noegleboks- og alarmkoder hentes
// kun gennem hent_adgangsinfo, som tjekker tilknytning og skriver en linje i access_log.
// En kopi paa telefonen ville saette hele den konstruktion ud af kraft.
//
// localStorage og ikke IndexedDB: en uges opgaver for én medarbejder fylder faa hundrede
// kilobyte, og localStorage er synkron og kraever ingen opsaetning. Skrivekoeen faar sin
// egen IndexedDB, for dér er der brug for at kunne rulle tilbage.
function kopiNoegle(empId, aar, uge) {
  return `wl_kopi_${empId}_${aar}_${uge}`;
}

function gemKopi(empId, aar, uge, indhold) {
  try {
    localStorage.setItem(kopiNoegle(empId, aar, uge), JSON.stringify({
      hentet: Date.now(),
      ...indhold,
    }));
  } catch {
    // Fuldt lager eller privat browsing. Kopien er en hjaelp, ikke et krav — appen
    // skal ikke gaa i staa fordi den ikke kunne gemmes.
  }
}

function laesKopi(empId, aar, uge) {
  try {
    const raa = localStorage.getItem(kopiNoegle(empId, aar, uge));
    if (!raa) return null;
    const k = JSON.parse(raa);
    // En kopi der er over en uge gammel er mere vildledende end ingenting. Planen kan
    // vaere lagt helt om siden da.
    if (!k.hentet || Date.now() - k.hentet > 7 * 24 * 60 * 60 * 1000) return null;
    return k;
  } catch {
    return null;
  }
}

// ── Skrivekoe ────────────────────────────────────────────────────────────────
// Skrivninger der ikke kom af sted lægges her og sendes naar der er daekning igen.
//
// Det forsvarlige ved konstruktionen ligger IKKE her, men i databasen: hver post
// baerer et id fra telefonen, og append_time_log og consume_stock afviser et id de
// har set foer. Uden den vagt ville en post der blev sendt to gange — fordi svaret
// forsvandt undervejs — give 120 minutter i stedet for 60, direkte i loen og paa
// fakturaen. Koeen maa gerne sende for meget; databasen sorterer fra.
//
// IndexedDB og ikke localStorage: fotos er Blobs, og de kan ikke gemmes som tekst.
const KOE_DB = "wl_koe";
const KOE_STORE = "skrivninger";

function aabnKoe() {
  return new Promise((ok, fejl) => {
    const anmod = indexedDB.open(KOE_DB, 1);
    anmod.onupgradeneeded = () => {
      const db = anmod.result;
      if (!db.objectStoreNames.contains(KOE_STORE)) {
        db.createObjectStore(KOE_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    anmod.onsuccess = () => ok(anmod.result);
    anmod.onerror = () => fejl(anmod.error);
  });
}

function koeKald(tilstand, arbejde) {
  return new Promise((ok, fejl) => {
    aabnKoe().then((db) => {
      const tx = db.transaction(KOE_STORE, tilstand);
      const anmod = arbejde(tx.objectStore(KOE_STORE));
      anmod.onsuccess = () => ok(anmod.result);
      anmod.onerror = () => fejl(anmod.error);
    }).catch(fejl);
  });
}

async function koeTilfoej(post) {
  try {
    const id = await koeKald("readwrite", (s) => s.add({ ...post, oprettet: Date.now() }));
    // Saa taelleren i baandet opdaterer sig, uanset hvilken skaerm der lagde posten
    // i koeen. Alternativet var at traede et tilbagekald igennem fire komponenter.
    window.dispatchEvent(new Event("wl-koe-aendret"));
    return id;
  } catch {
    return null;
  }
}

async function koeAlle() {
  try {
    const alle = await koeKald("readonly", (s) => s.getAll());
    return (alle || []).sort((a, b) => a.id - b.id);
  } catch {
    return [];
  }
}

async function koeFjern(id) {
  try { await koeKald("readwrite", (s) => s.delete(id)); } catch { /* ingenting at goere */ }
}

// Sand naar fejlen skyldes forbindelsen og ikke indholdet. En afvisning fra databasen
// — forkerte rettigheder, en raekke der ikke findes — skal IKKE proeves igen i det
// uendelige; den skal frem i lyset.
function erNetvaerksfejl(fejl) {
  if (!navigator.onLine) return true;
  const m = String(fejl?.message ?? fejl ?? "").toLowerCase();
  return m.includes("fetch") || m.includes("network") || m.includes("load failed")
      || m.includes("timeout") || m.includes("failed to fetch");
}

// Udfoerer én post fra koeen. Rækkefølgen betyder noget: et notat skal findes foer
// dets billeder kan haenges paa, saa koeen behandles i den orden den blev fyldt.
async function udfoerKoePost(klient, post) {
  const a = post.args || {};
  switch (post.art) {
    case "tid":
      return klient.rpc("append_time_log", {
        p_instance_id: a.opgaveId, p_minutes: a.minutter, p_emp_id: a.empId,
        p_note: a.note ?? null, p_klient_id: a.noegle,
      });
    case "status":
      return klient.rpc("set_employee_task_status", {
        p_instance_id: a.opgaveId, p_emp_id: a.empId, p_done: a.faerdig,
      });
    case "tjekliste":
      return klient.from("instances").update({ checklist: a.checklist }).eq("id", a.opgaveId);
    case "nexus":
      return klient.from("instances").update({ nexus_confirmed: a.bekraeftet }).eq("id", a.opgaveId);
    case "notat":
      return klient.from("task_notes").upsert(a.raekke, { onConflict: "id" });
    case "foto": {
      const { error } = await klient.storage.from("opgavefotos")
        .upload(a.sti, a.blob, { contentType: "image/jpeg", upsert: false });
      // Stien er fast, saa ligger filen der allerede, ER billedet sendt.
      const findes = error && (String(error.statusCode) === "409" || /exists/i.test(error.message || ""));
      return { error: findes ? null : error };
    }
    case "fotostier":
      return klient.from("task_notes").update({ photos: a.stier }).eq("id", a.notatId);
    case "oenske":
      return klient.from("reschedule_requests").upsert(a.raekke, { onConflict: "id" });
    case "udlevering":
      return klient.rpc("bekraeft_udlevering", { p_instance_id: a.opgaveId });
    default:
      // Ukendt art — fjern den hellere end at blokere resten af koeen for evigt.
      return { error: null };
  }
}

// Toemmer koeen. Stopper ved foerste netvaerksfejl, saa raekkefoelgen holder.
// Returnerer hvor mange der er tilbage.
async function toemKoe(klient, empId) {
  const poster = await koeAlle();
  for (const post of poster) {
    try {
      const { error } = await udfoerKoePost(klient, post);
      if (error) {
        if (erNetvaerksfejl(error)) return (await koeAlle()).length;
        // Databasen afviste den. Den kommer aldrig igennem, og en koe der sidder
        // fast paa en umulig post ville spaerre alt bagved.
        console.error("koe afvist:", post.art, error.message);
        await koeFjern(post.id);
        continue;
      }
      await koeFjern(post.id);
      // Maaling: hvor laenge maatte den vente? Formaalet er at kunne se efter en
      // maaned om koeen bruges to gange eller to hundrede — og dermed om der er
      // grund til at bygge mere. Fejler maalingen, er det ligegyldigt; den maa
      // aldrig staa i vejen for at selve skrivningen kom af sted.
      try {
        await klient.from("koe_maaling").insert({
          employee_id: empId ?? null,
          art: post.art,
          ventede_sek: Math.max(0, Math.round((Date.now() - (post.oprettet || Date.now())) / 1000)),
        });
      } catch { /* maalingen maa ikke forstyrre driften */ }
    } catch (e) {
      if (erNetvaerksfejl(e)) return (await koeAlle()).length;
      console.error("koe fejl:", post.art, e);
      await koeFjern(post.id);
    }
  }
  return (await koeAlle()).length;
}

// ── Adgangsoplysninger hentet paa forhaand ───────────────────────────────────
// Noegleboks- og alarmkoder gemmes KUN naar hun selv har hentet dem — og saa kun
// dagen ud. Det er et bevidst valg, truffet af Jonn:
//
// Pointen med adgangskontrollen er at OPSLAGET bliver logget, ikke at det skal ske ved
// doeren. Har hun hentet koden mens hun havde daekning, staar linjen i access_log med
// navn og tidspunkt. At koden derefter ligger paa telefonen aendrer ikke paa sporet.
//
// Til gengaeld ligger kundernes koder saa paa en privat telefon en hel arbejdsdag. Det
// er borgeres og aeldres hjem, og ordningen skal staa i persondatadokumentationen.
// Derfor: kun dagen ud, ryddet automatisk, og ryddet ved log ud.
function iDagNoegle() {
  return new Date().toISOString().slice(0, 10);
}

function gemAdgang(opgaveId, tekst) {
  try {
    const raa = localStorage.getItem("wl_adgang");
    const gemt = raa ? JSON.parse(raa) : {};
    // Skiftede dagen, starter vi forfra. Det er den automatiske oprydning.
    const bog = gemt.dag === iDagNoegle() ? gemt : { dag: iDagNoegle(), koder: {} };
    bog.koder[opgaveId] = tekst ?? "";
    localStorage.setItem("wl_adgang", JSON.stringify(bog));
  } catch { /* fuldt lager — kopien er en hjaelp, ikke et krav */ }
}

function laesAdgang(opgaveId) {
  try {
    const raa = localStorage.getItem("wl_adgang");
    if (!raa) return null;
    const bog = JSON.parse(raa);
    if (bog.dag !== iDagNoegle()) {
      // Gaar hun ind i appen dagen efter, ryddes gaarsdagens koder her.
      localStorage.removeItem("wl_adgang");
      return null;
    }
    const v = bog.koder?.[opgaveId];
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

function rydAdgang() {
  try { localStorage.removeItem("wl_adgang"); } catch { /* ingenting at goere */ }
}

// Ryddes ved log ud. Ellers ville den naeste der loggede ind paa samme telefon kunne
// se den forriges opgaver med kundenavne og adresser.
function rydKopier() {
  try {
    Object.keys(localStorage)
      .filter((n) => n.startsWith("wl_kopi_"))
      .forEach((n) => localStorage.removeItem(n));
  } catch { /* ingenting at goere */ }
}

// ── i18n ─────────────────────────────────────────────────────────────────────
const T = {
  da: {
    appName: "Worklist",
    appSub: "Medarbejder-app",
    emailLabel: "E-mailadresse",
    emailPlaceholder: "din@email.dk",
    passwordLabel: "Adgangskode",
    loginBtn: "Log ind",
    loggingIn: "Logger ind…",
    loginError: "Forkert e-mail eller adgangskode",
    forgotPassword: "Glemt adgangskode?",
    forgotPasswordEmailRequired: "Indtast din e-mail for at nulstille adgangskoden",
    resetSentMsg: (email) => `Der er sendt et link til nulstilling af adgangskode til ${email}, hvis e-mailen findes i systemet.`,
    resetError: "Kunne ikke sende nulstillingslink — prøv igen.",
    newPasswordTitle: "Nulstil adgangskode",
    newPasswordLabel: "Ny adgangskode",
    repeatPasswordLabel: "Gentag adgangskode",
    passwordTooShort: "Adgangskoden skal være mindst 6 tegn",
    passwordMismatch: "Adgangskoderne er ikke ens",
    saveNewPassword: "Gem ny adgangskode",
    savingPassword: "Gemmer…",
    passwordUpdated: "Din adgangskode er opdateret.",
    continueBtn: "Fortsæt",
    passwordUpdateError: "Kunne ikke opdatere adgangskode — prøv igen.",
    loading: "Indlæser…",
    fetchingTasks: "Henter opgaver…",
    noProfileError: "Din bruger er ikke koblet til en medarbejder-profil. Kontakt din planlægger.",
    signOut: "Log ud",
    week: "Uge",
    thisWeek: "Denne uge",
    today: "I dag",
    days: [
      { key: "Mon", label: "Mandag", short: "Man" },
      { key: "Tue", label: "Tirsdag", short: "Tir" },
      { key: "Wed", label: "Onsdag", short: "Ons" },
      { key: "Thu", label: "Torsdag", short: "Tor" },
      { key: "Fri", label: "Fredag", short: "Fre" },
      { key: "Sat", label: "Lørdag", short: "Lør", weekend: true },
      { key: "Sun", label: "Søndag", short: "Søn", weekend: true },
    ],
    noTasks: (day) => `Ingen opgaver ${day}`,
    freeDayNote: "Fri dag eller ingen tildelte opgaver",
    travel: "Kørsel",
    travelFromHome: "Kørsel hjemmefra",
    travelToHome: "Kørsel hjem",
    accessShow: "Vis adgangsoplysninger",
    accessOpening: "Henter…",
    accessHint: "Nøglebokskoder, alarmkoder og kontaktoplysninger er skjult. Når du åbner dem, registreres det med dit navn og tidspunkt.",
    accessLogged: "Åbningen er registreret.",
    accessNone: "Der er ingen adgangsoplysninger på denne opgave.",
    accessFailed: "Kunne ikke hente adgangsoplysningerne. Tjek forbindelsen og prøv igen.",
    navigate: "Naviger",
    customer: "Kunde",
    access: "Adgang",
    watchVideo: "Se instruktionsvideo",
    tasks: "Tasks",
    timeTracking: "Tidsregistrering",
    registered: "registreret",
    planned: "planlagt",
    allTeam: "Alle:",
    inTotal: "i alt",
    openNexus: "Åbn KMD Nexus Mobile",
    overrunTitle: "Registreret tid overskrider planlagt tid",
    overrunBody: (reg, plan) => `Med denne registrering bliver der brugt ${reg} på opgaven, men der er kun planlagt ${plan}. Angiv en begrundelse for overskridelsen.`,
    overrunPlaceholder: "Begrundelse for overskridelsen…",
    overrunRequired: "Du skal angive en begrundelse for at registrere tiden.",
    saving: "Gemmer…",
    markNotDone: "Marker som ikke udført",
    status: { planlagt: "Planlagt", i_gang: "I gang", udført: "Udført" },
    taskVideo: "Se video",
    notesTitle: "Kommentar og billeder",
    notesPlaceholder: "Hvad skal kontoret vide?",
    photoCamera: "Tag billede",
    photoLibrary: "Fra galleri",
    photoCount: "billeder klar",
    photoMax: "Du kan sende 10 billeder ad gangen",
    photos: "Billeder",
    products: "Produkter",
    back: "Tilbage",
    ofSteps: "af",
    finishTask: "Afslut opgaven",
    finishNextStep: "Videre",
    finishTimeQ: "Hvor lang tid brugte du?",
    finishTimePlanned: (t) => `Der er sat ${t} af til dig på opgaven`,
    finishPerPerson: (n, samlet) => `Der er ${n} på opgaven, så der er afsat ${samlet} i alt.`,
    finishHours: "Timer",
    finishMinutes: "Minutter — i spring af 5",
    finishAsPlanned: "som planlagt",
    finishMoreThan: (t) => `${t} mere end planlagt`,
    finishLessThan: (t) => `${t} mindre end planlagt`,
    finishWhyMore: "Skriv hvorfor der gik længere tid — så kan kontoret forklare det til kunden.",
    finishNeedTime: "Sæt tiden, før du går videre.",
    newVersion: "Ny version klar — tryk for at opdatere",
    savedCopy: "Gemt kopi — ingen forbindelse",
    queueWaiting: (n) => n === 1 ? "1 registrering venter på dækning" : `${n} registreringer venter på dækning`,
    queueHint: "De sendes af sig selv når du har forbindelse. Luk ikke appen helt før det er sket.",
    queueSending: "Sender…",
    queueSendNow: "Send nu",
    queueOnSignOut: (n) => `Der er ${n} registrering(er) der ikke er sendt endnu. Logger du ud, går de tabt. Vil du logge ud alligevel?`,
    accessOffline: "Ingen forbindelse, og du har ikke hentet adgangen til denne opgave i dag. Ring til kontoret.",
    accessFromCopy: "Hentet tidligere i dag — gemmes kun til i nat",
    fetchAccessAll: "Hent dagens adgangsoplysninger",
    fetchAccessHint: (n) => `${n} af dagens opgaver mangler. Hent dem mens du har dækning.`,
    fetchAccessDone: "Dagens adgangsoplysninger er hentet",
    fetchAccessWorking: "Henter…",
    savedCopyFrom: (t) => `Hentet ${t}. Nye ændringer fra kontoret er ikke med.`,
    offlineTitle: "Ingen forbindelse lige nu",
    offlineHint: "Dine opgaver kunne ikke hentes. Prøv igen når du har dækning — der er ikke noget galt med din bruger.",
    tryAgain: "Prøv igen",
    finishHandoverQ: "Har kunden fået de produkter du hentede på kontoret?",
    finishHandoverHint: "Det her fik du med. Bekræft kun det kunden faktisk har fået.",
    finishHandoverYes: "Ja, kunden har fået dem",
    finishHandoverNo: "Nej, ikke denne gang",
    finishHandoverRequired: "Vælg ja eller nej, før du går videre.",
    finishHandoverFoot: "Siger du nej, bliver de stående hos dig og dukker op igen næste gang du er hos kunden. Kunden får først en regning for dem når du har sagt ja.",
    finishAlready: (t) => `Der er allerede registreret ${t} på opgaven. Skriv kun den tid du vil lægge til.`,
    finishZeroOk: "Skal du ikke tilføje mere tid, lader du bare 0 stå og trykker Videre.",
    finishSaveFailed: "Kunne ikke gemme. Tjek at du har forbindelse, og prøv igen.",
    finishNoteQ: "Er der noget kontoret skal vide?",
    finishNoteHint: "Var der ekstra beskidt, eller noget i stykker? Tag et billede.",
    finishNothingHappened: "Spring over — der skete ikke noget",
    finishDone: "Opgaven er afsluttet",
    finishNext: "Tilbage til dagens opgaver",
    finishNextList: "Tilbage til listen",
    finishKmNote: "Din kørsel bliver beregnet i nat, nu hvor tiden er registreret.",
    nexusQ: "Husk at kvittere i Nexus",
    nexusHint: "Kommunen betaler efter det der står i Nexus — ikke efter det du skriver her.",
    nexusOpenNow: "Åbn Nexus nu",
    nexusConfirm: "Ja, jeg har kvitteret i Nexus",
    nexusSkipNote: "Kom du ikke i Nexus? Sæt ikke flueben — så følger kontoret op. Du kan godt afslutte alligevel.",
    nexusDone: "kvitteret",
    nexusMissing: "mangler",
    // ── Det du mangler ──
    gapsTitle: "Det du mangler",
    gapsAria: "Se hvad du mangler at registrere",
    gapsLoading: "Henter…",
    gapsError: "Listen kunne ikke hentes. Prøv igen, når du har dækning.",
    gapsNone: "Du mangler ingenting. Alt er registreret og afsluttet.",
    gapsLead: (n) => (n === 1
      ? "Der er én opgave, du mangler at gøre færdig."
      : `Der er ${n} opgaver, du mangler at gøre færdig.`),
    gapsLeadOther: (n, navn) => (n === 1
      ? `${navn} mangler at gøre én opgave færdig.`
      : `${navn} mangler at gøre ${n} opgaver færdige.`),
    gapsNoneOther: (navn) => `${navn} mangler ingenting. Alt er registreret og afsluttet.`,
    gapsHint: "Tryk på en opgave for at åbne den. Ældste øverst — de er tættest på at gå tabt.",
    gapsMonthWarn: "Når måneden lukker, kan timerne og kørslen ikke længere komme med på lønnen.",
    gapsNeedTime: "tid",
    gapsNeedDone: "udført",
    gapsNeedBoth: "tid og udført",
    gapsLogged: (m) => `${m} min registreret`,
    finishOpen: "Afslut opgave",
    reportProblem: "Der er et problem",
    reportProblemTitle: "Hvad er der sket?",
    reportProblemHint: "Vælg det der passer. Kontoret får besked med det samme.",
    reportNewTimeCard: "Du har aftalt et nyt tidspunkt med kunden, og opgaven skal flyttes.",
    reportNoEntryCard: "Du stod ved døren, men kom ikke ind, og opgaven blev ikke udført.",
    reportNewTimeQ: "Hvornår skal den flyttes til?",
    reportNewTimeHint: "Skriv den dato I har aftalt. Kontoret flytter opgaven — du skal ikke selv gøre mere.",
    reportNewDate: "Ny dato",
    reportNewClock: "Klokkeslæt (valgfrit)",
    reportWhyMove: "Hvorfor skal den flyttes?",
    reportWhyMovePlaceholder: "F.eks. kunden er til lægen, eller der var håndværkere",
    reportSend: "Send til kontoret",
    reportSending: "Sender…",
    reportSentTitle: "Kontoret har fået besked",
    reportSentNewTime: "Opgaven bliver stående hos dig, indtil planlæggeren har flyttet den. Du får en mail hvis det ikke kan lade sig gøre.",
    reportBackToTask: "Tilbage til opgaven",
    reportSentNoEntryShort: "Meldt som forgæves besøg",
    reportSentNewTimeShort: "Ønske om ny tid er sendt",
    notesSending: "Gemmer…",
    notesPhotoProgress: "Sender billede",
    notesPhotosDeleted: "Billederne er slettet efter 12 måneder.",
    reportNewTime: "Foreslå ny tid",
    reportNoEntry: "Kunne ikke komme ind",
    reportNoEntryHint: "Kontoret afgør om kunden skal betale alligevel. Tag gerne et billede som dokumentation.",
    reportNoEntryWhy: "Hvad skete der?",
    reportNoEntryPlaceholder: "F.eks. ingen svarede, og nøglen passede ikke",
    reportNewDateOptional: "Ny dato (valgfrit)",
    reportSentNoEntry: "Kontoret har fået besked. De afgør om opgaven skal faktureres.",
  },
  en: {
    appName: "Worklist",
    appSub: "Staff app",
    emailLabel: "Email address",
    emailPlaceholder: "your@email.com",
    passwordLabel: "Password",
    loginBtn: "Log in",
    loggingIn: "Logging in…",
    loginError: "Incorrect email or password",
    forgotPassword: "Forgot password?",
    forgotPasswordEmailRequired: "Enter your email to reset your password",
    resetSentMsg: (email) => `A password reset link has been sent to ${email}, if the email exists in the system.`,
    resetError: "Could not send reset link — please try again.",
    newPasswordTitle: "Reset password",
    newPasswordLabel: "New password",
    repeatPasswordLabel: "Repeat password",
    passwordTooShort: "Password must be at least 6 characters",
    passwordMismatch: "Passwords do not match",
    saveNewPassword: "Save new password",
    savingPassword: "Saving…",
    passwordUpdated: "Your password has been updated.",
    continueBtn: "Continue",
    passwordUpdateError: "Could not update password — please try again.",
    loading: "Loading…",
    fetchingTasks: "Fetching tasks…",
    noProfileError: "Your user is not linked to an employee profile. Contact your planner.",
    signOut: "Log out",
    week: "Week",
    thisWeek: "This week",
    today: "Today",
    days: [
      { key: "Mon", label: "Monday", short: "Mon" },
      { key: "Tue", label: "Tuesday", short: "Tue" },
      { key: "Wed", label: "Wednesday", short: "Wed" },
      { key: "Thu", label: "Thursday", short: "Thu" },
      { key: "Fri", label: "Friday", short: "Fri" },
      { key: "Sat", label: "Saturday", short: "Sat", weekend: true },
      { key: "Sun", label: "Sunday", short: "Sun", weekend: true },
    ],
    noTasks: (day) => `No tasks ${day}`,
    freeDayNote: "Day off or no assigned tasks",
    travel: "Travel",
    travelFromHome: "Travel from home",
    travelToHome: "Travel home",
    accessShow: "Show access details",
    accessOpening: "Loading…",
    accessHint: "Key box codes, alarm codes and contact details are hidden. When you open them, it is recorded with your name and the time.",
    accessLogged: "This opening has been recorded.",
    accessNone: "There are no access details on this job.",
    accessFailed: "Could not load the access details. Check your connection and try again.",
    navigate: "Navigate",
    customer: "Customer",
    access: "Access",
    watchVideo: "Watch instruction video",
    tasks: "Tasks",
    timeTracking: "Time tracking",
    registered: "registered",
    planned: "planned",
    allTeam: "Team total:",
    inTotal: "in total",
    openNexus: "Open KMD Nexus Mobile",
    overrunTitle: "Registered time exceeds planned time",
    overrunBody: (reg, plan) => `With this entry, ${reg} will have been spent on the task, but only ${plan} is planned. Please state a reason for the overrun.`,
    overrunPlaceholder: "Reason for the overrun…",
    overrunRequired: "You must state a reason to register the time.",
    saving: "Saving…",
    markNotDone: "Mark as not completed",
    status: { planlagt: "Planned", i_gang: "In progress", udført: "Completed" },
    taskVideo: "Watch video",
    notesTitle: "Comments and photos",
    notesPlaceholder: "What should the office know?",
    photoCamera: "Take photo",
    photoLibrary: "From gallery",
    photoCount: "photos ready",
    photoMax: "You can send 10 photos at a time",
    photos: "Photos",
    products: "Products",
    back: "Back",
    ofSteps: "of",
    finishTask: "Complete the job",
    finishNextStep: "Next",
    finishTimeQ: "How long did it take?",
    finishTimePlanned: (t) => `${t} is planned for you on this job`,
    finishPerPerson: (n, samlet) => `There are ${n} of you on this job, so ${samlet} is planned in total.`,
    finishHours: "Hours",
    finishMinutes: "Minutes — in steps of 5",
    finishAsPlanned: "as planned",
    finishMoreThan: (t) => `${t} more than planned`,
    finishLessThan: (t) => `${t} less than planned`,
    finishWhyMore: "Write why it took longer — so the office can explain it to the customer.",
    finishNeedTime: "Set the time before you continue.",
    newVersion: "New version ready — tap to update",
    savedCopy: "Saved copy — no connection",
    queueWaiting: (n) => n === 1 ? "1 entry is waiting for coverage" : `${n} entries are waiting for coverage`,
    queueHint: "They are sent automatically once you have a connection. Do not close the app completely before that.",
    queueSending: "Sending…",
    queueSendNow: "Send now",
    queueOnSignOut: (n) => `${n} entr(ies) have not been sent yet. If you sign out they will be lost. Sign out anyway?`,
    accessOffline: "No connection, and you have not fetched the access details for this job today. Call the office.",
    accessFromCopy: "Fetched earlier today — kept only until tonight",
    fetchAccessAll: "Fetch today's access details",
    fetchAccessHint: (n) => `${n} of today's jobs are missing them. Fetch them while you have coverage.`,
    fetchAccessDone: "Today's access details have been fetched",
    fetchAccessWorking: "Fetching…",
    savedCopyFrom: (t) => `Fetched ${t}. Changes from the office since then are not included.`,
    offlineTitle: "No connection right now",
    offlineHint: "Your jobs could not be loaded. Try again when you have coverage — there is nothing wrong with your account.",
    tryAgain: "Try again",
    finishHandoverQ: "Did the customer get the products you picked up at the office?",
    finishHandoverHint: "This is what you were given. Only confirm what the customer actually received.",
    finishHandoverYes: "Yes, the customer got them",
    finishHandoverNo: "No, not this time",
    finishHandoverRequired: "Choose yes or no before you continue.",
    finishHandoverFoot: "If you say no, they stay with you and show up again next time you visit this customer. The customer is only invoiced once you say yes.",
    finishAlready: (t) => `${t} is already registered on this job. Only enter the time you want to add.`,
    finishZeroOk: "If you are not adding more time, just leave it at 0 and tap Next.",
    finishSaveFailed: "Could not save. Check your connection and try again.",
    finishNoteQ: "Anything the office should know?",
    finishNoteHint: "Was it extra dirty, or was something broken? Take a photo.",
    finishNothingHappened: "Skip — nothing happened",
    finishDone: "The job is complete",
    finishNext: "Back to today's jobs",
    finishNextList: "Back to the list",
    finishKmNote: "Your mileage will be calculated tonight, now that the time is logged.",
    nexusQ: "Remember to sign off in Nexus",
    nexusHint: "The municipality pays according to Nexus — not according to what you write here.",
    nexusOpenNow: "Open Nexus now",
    nexusConfirm: "Yes, I have signed off in Nexus",
    nexusSkipNote: "Could not get into Nexus? Leave it unticked — the office will follow up. You can still finish.",
    nexusDone: "signed off",
    nexusMissing: "missing",
    // ── What you are missing ──
    gapsTitle: "What you are missing",
    gapsAria: "See what you still need to register",
    gapsLoading: "Loading…",
    gapsError: "The list could not be loaded. Try again when you have coverage.",
    gapsNone: "You are not missing anything. Everything is registered and completed.",
    gapsLead: (n) => (n === 1
      ? "There is one job you still need to finish."
      : `There are ${n} jobs you still need to finish.`),
    gapsLeadOther: (n, navn) => (n === 1
      ? `${navn} has one job left to finish.`
      : `${navn} has ${n} jobs left to finish.`),
    gapsNoneOther: (navn) => `${navn} is not missing anything. Everything is registered and completed.`,
    gapsHint: "Tap a job to open it. Oldest first — those are closest to being lost.",
    gapsMonthWarn: "Once the month closes, the hours and mileage can no longer go to payroll.",
    gapsNeedTime: "time",
    gapsNeedDone: "completion",
    gapsNeedBoth: "time and completion",
    gapsLogged: (m) => `${m} min logged`,
    finishOpen: "Complete job",
    reportProblem: "There is a problem",
    reportProblemTitle: "What happened?",
    reportProblemHint: "Pick whichever fits. The office is notified straight away.",
    reportNewTimeCard: "You agreed a new time with the customer, and the job needs moving.",
    reportNoEntryCard: "You were at the door but could not get in, and the job was not done.",
    reportNewTimeQ: "When should it move to?",
    reportNewTimeHint: "Enter the date you agreed. The office moves the job — you do not need to do anything else.",
    reportNewDate: "New date",
    reportNewClock: "Time (optional)",
    reportWhyMove: "Why does it need moving?",
    reportWhyMovePlaceholder: "E.g. the customer is at the doctor, or there were builders in",
    reportSend: "Send to the office",
    reportSending: "Sending…",
    reportSentTitle: "The office has been notified",
    reportSentNewTime: "The job stays with you until the planner has moved it. You will get an email if it is not possible.",
    reportBackToTask: "Back to the job",
    reportSentNoEntryShort: "Reported as a wasted visit",
    reportSentNewTimeShort: "Request for a new time sent",
    notesSending: "Saving…",
    notesPhotoProgress: "Sending photo",
    notesPhotosDeleted: "Photos were deleted after 12 months.",
    reportNewTime: "Suggest a new time",
    reportNoEntry: "Could not get in",
    reportNoEntryHint: "The office decides whether the customer still pays. Please add a photo as documentation.",
    reportNoEntryWhy: "What happened?",
    reportNoEntryPlaceholder: "E.g. nobody answered and the key did not fit",
    reportNewDateOptional: "New date (optional)",
    reportSentNoEntry: "The office has been notified. They decide whether the task is invoiced.",
  },
};

// ── Translation helper ───────────────────────────────────────────────────────
const translateCache = {};

async function translateText(text, targetLang) {
  if (!text || targetLang === "da") return text;
  const cacheKey = `${targetLang}:${text}`;
  if (translateCache[cacheKey]) return translateCache[cacheKey];

  console.log("[translate] Translating:", text, "→", targetLang);

  // Prøv MyMemory API
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=da|${targetLang}&de=app@worklist.dk`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const translated = data?.responseData?.translatedText;
      if (translated && translated !== text) {
        console.log("[translate] Success:", translated);
        translateCache[cacheKey] = translated;
        return translated;
      }
    }
  } catch (e) {
    console.warn("[translate] MyMemory failed:", e.message);
  }

  // Fallback: Lingva API (open source Google Translate frontend)
  try {
    const url = `https://lingva.ml/api/v1/da/${targetLang}/${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const translated = data?.translation;
      if (translated) {
        console.log("[translate] Lingva success:", translated);
        translateCache[cacheKey] = translated;
        return translated;
      }
    }
  } catch (e) {
    console.warn("[translate] Lingva failed:", e.message);
  }

  console.warn("[translate] All APIs failed, returning original");
  return text;
}

async function translateTask(task, targetLang) {
  if (targetLang === "da") return task;
  // Adgangsteksten oversaettes ikke laengere: den findes slet ikke paa opgaven, men
  // hentes foerst naar medarbejderen aabner den. Den skal i oevrigt ikke sendes til en
  // oversaettelsestjeneste — en noeglebokskode har intet at goere hos en tredjepart.
  const [title, checklist] = await Promise.all([
    translateText(task.title, targetLang),
    Promise.all((task.checklist || []).map(async (item) => ({
      ...item,
      text: await translateText(item.text, targetLang),
      description: await translateText(item.description, targetLang),
    }))),
  ]);
  return { ...task, title, checklist };
}
// Hvor meget af skaermen er der reelt tilbage?
//
// Naar tastaturet kommer op paa iOS, krymper layout-viewporten IKKE. Et element med
// position:fixed og inset:0 bliver ved med at vaere skaermhoejt, og alt i bunden
// havner under tastaturet. Det var derfor "Afslut opgaven" blev klippet over, saa
// snart man skrev i beskeden til kontoret.
//
// visualViewport er den del der faktisk er synlig. Vi laeser hoejden derfra og
// saetter den paa arket, saa det krymper i stedet for at gemme sig bagved.
//
// offsetTop er ogsaa noedvendig: ruller iOS hele siden op for at gøre plads til
// tastaturet, skal arket foelge med ned igen — ellers staar toppen uden for skaermen.
function useSynligHoejde() {
  const [maal, setMaal] = useState(() => ({
    hoejde: typeof window !== "undefined" && window.visualViewport
      ? window.visualViewport.height : "100%",
    top: 0,
  }));

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;                      // Aeldre browsere: alt som foer.
    const opdater = () => setMaal({ hoejde: vv.height, top: vv.offsetTop });
    opdater();
    vv.addEventListener("resize", opdater);
    vv.addEventListener("scroll", opdater);
    return () => {
      vv.removeEventListener("resize", opdater);
      vv.removeEventListener("scroll", opdater);
    };
  }, []);

  return maal;
}

// ── Solsikken ────────────────────────────────────────────────────────────────
//
// Et paaskeaeg. Charlotte og Jonna har bygget systemet sammen, og hendes navn faar
// en solsikke — men kun paa deres to skaerme. Alle andre ser navnet som det staar.
//
// DEN MAA ALDRIG NAA DATA. Mails, loenfilen og alt der sendes videre laeser navnet
// fra employees.name og roerer ikke den her funktion. Solsikken saettes foerst naar
// navnet TEGNES. Laa den i datalaget, ville den foer eller siden staa i en faktura.
// Charlotte findes paa sit id og ikke paa sit navn. Foerste udgave slog op paa
// navnetekst, og listen indeholdt "Jonna Jensen IT" — en medarbejder der siden er
// omdoebt til "Udvikler IT". Dermed holdt solsikken op med at vise sig, uden at nogen
// kunne se hvorfor: der var ingen fejl, kun en streng der ikke passede paa noget mere.
const SOLSIKKE_ID = "e5";                  // Charlotte Thorsager Kronborg

// Hvem der maa se den: alle planlaeggere. Ikke en liste over bestemte personer.
//
// En navngiven liste skal vedligeholdes, og det er lige praecis dét, der gik galt
// foerste gang. Kontoret skifter desuden mellem medarbejdere hele tiden — det skal
// vaere den, der SIDDER ved planen, der ser den, uanset hvem hun kigger paa.
let solsikkeSeerErPlanlaegger = false;
function saetSolsikkeSeer(erPlanlaegger) { solsikkeSeerErPlanlaegger = !!erPlanlaegger; }

function medSolsikke(navn, empId) {
  if (empId !== SOLSIKKE_ID) return navn;
  return solsikkeSeerErPlanlaegger ? navn + " \u{1F33B}" : navn;
}

// Initialerne i den runde knap. Er det Charlotte selv der er logget ind, staar der
// en solsikke i stedet for "CT" — det er hendes app, og hun ved godt hvem hun er.
// Alle andre faar deres egne initialer som foer.
function avatarTegn(navn, empId) {
  // Avataren i hjoernet er altid den indloggedes egen, saa er id'et Charlottes, er
  // det Charlotte selv der kigger. Ingen grund til ogsaa at spoerge om seeren.
  if (empId === SOLSIKKE_ID) return "\u{1F33B}";
  return (navn || "").split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function fmtMin(min) {
  if (!min || min <= 0) return "0m";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h${m > 0 ? " " + m + "m" : ""}` : `${m}m`;
}
function fmtClock(minutesFromMidnight) {
  const h = Math.floor(minutesFromMidnight / 60) % 24;
  const m = Math.round(minutesFromMidnight % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
// Ugeregningen ligger i src/uger.js med sin egen test. Den kan tage fejl uden at
// sige noget — en forkert uge giver en forkert dagsliste, ikke en fejlmeddelelse.
// ---- KMD Nexus Mobile: åbn appen hvis den er installeret, ellers hent den ----
// Identifikatorer verificeret mod de officielle butikssider (udgiver KMD A/S):
//   iOS      https://apps.apple.com/dk/app/kmd-nexus-mobile/id6449771475
//   Android  https://play.google.com/store/apps/details?id=dk.kmd.homecare
// Bemærk: "KMD Nexus Mobile II" er en ANDEN, ældre app (id1189227406 /
// kmd.mobile.nexus_ii). Den tidligere kode pegede på et opdigtet ID og virkede derfor aldrig.
const NEXUS_IOS_APP_ID = "6449771475";
const NEXUS_ANDROID_PACKAGE = "dk.kmd.homecare";
const NEXUS_APP_STORE_URL = `https://apps.apple.com/dk/app/kmd-nexus-mobile/id${NEXUS_IOS_APP_ID}`;
const NEXUS_PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${NEXUS_ANDROID_PACKAGE}`;
// KMD offentliggør ikke deres iOS URL-scheme. Bliver det bekræftet hos KMD,
// rettes det ét sted her, og iOS åbner appen direkte i stedet for via App Store.
const NEXUS_IOS_SCHEME = "kmdnexus://";

function openNexusApp() {
  const ua = navigator.userAgent || "";
  const isAndroid = /android/i.test(ua);

  if (isAndroid) {
    // Android: bed om appens startskaerm — praecis som at trykke paa ikonet.
    //
    // Tidligere bad vi om at aabne adressen "https://open" inde i appen. Det
    // forudsatte at KMD havde erklaeret netop den adresse i appen, og det har de
    // ikke. Android kunne derfor ikke afgoere hvad der skulle aabnes, og resultatet
    // var uforudsigeligt — nogle telefoner landede et forkert sted.
    //
    // MAIN + LAUNCHER er den handling telefonen selv bruger, naar man trykker paa
    // app-ikonet, og den findes i enhver app. Er appen ikke installeret, sender
    // browseren i stedet brugeren til Play Store via browser_fallback_url.
    window.location.href =
      `intent://#Intent;package=${NEXUS_ANDROID_PACKAGE};` +
      `action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;` +
      `S.browser_fallback_url=${encodeURIComponent(NEXUS_PLAY_STORE_URL)};end`;
    return;
  }

  // iOS/desktop: KMD offentliggør ikke deres iOS URL-scheme, så et gættet scheme
  // (fx "kmdnexus://") giver en "Safari kan ikke åbne siden, fordi adressen er
  // ugyldig"-fejl i stedet for at åbne appen. Derfor går vi direkte til App Store,
  // hvor "ÅBEN"-knappen vises automatisk hvis appen allerede er installeret.
  window.open(NEXUS_APP_STORE_URL, "_blank", "noopener");
}

function todayKey() {
  const keys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return keys[new Date().getDay()];
}
// Medarbejdervaelgeren maa kun findes paa en computer. Ude i marken bruger alle
// telefonen, og der skal skaermen vise ens egen dag og intet andet. Bemaerk at
// dette er en bekvemmelighed, ikke en spaerring — den rigtige beskyttelse er at
// databasen kun lader administratorer laese andres opgaver.
function isDesktopBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  if (typeof window !== "undefined" && window.matchMedia
      && window.matchMedia("(display-mode: standalone)").matches) return false;
  return true;
}
function todayWorkdayKey() {
  // Returner nærmeste hverdag (til default dag-valg)
  const keys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const k = keys[new Date().getDay()];
  if (k === "Sat") return "Fri";
  if (k === "Sun") return "Mon";
  return k;
}
// ── Opgavefotos ──────────────────────────────────────────────────────────────
// Et telefonbillede fylder 3-5 MB raat. Medarbejderne staar ude hos kunderne paa
// mobilnet, og en upload paa 4 MB kan tage et halvt minut i Jammerbugt — laenge nok
// til at man giver op og lader vaere med at dokumentere noget. Derfor skaleres og
// komprimeres billedet i browseren foerst; ~200 KB er rigeligt til at vise en plet
// paa et gulv eller en laast doer.
const FOTO_MAKS_KANT = 1600;
const FOTO_KVALITET = 0.72;
// Ti billeder pr. notat. Ved ~200 KB stykket er det 2 MB i alt, hvilket stadig kan
// sendes fra en mark i Jammerbugt — men det tager laenge nok til at medarbejderen
// skal kunne se at der sker noget undervejs.
const MAKS_FOTOS = 10;

function komprimerBillede(fil) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fil);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const skala = Math.min(1, FOTO_MAKS_KANT / Math.max(img.width, img.height));
      const bredde = Math.round(img.width * skala);
      const hoejde = Math.round(img.height * skala);
      const canvas = document.createElement("canvas");
      canvas.width = bredde;
      canvas.height = hoejde;
      canvas.getContext("2d").drawImage(img, 0, 0, bredde, hoejde);
      // JPEG frem for PNG: et foto af et rum komprimerer 10 gange bedre som JPEG,
      // og vi har ingen brug for skarpe kanter eller gennemsigtighed.
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Kunne ikke behandle billedet"))),
        "image/jpeg",
        FOTO_KVALITET,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Filen er ikke et billede")); };
    img.src = url;
  });
}

// Stien er altid <opgave-id>/<notat-id>-<nr>.jpg. Adgangspolitikken i databasen
// laeser opgavens id ud af foerste mappeniveau, saa moenstret maa ikke aendres
// uden at politikken paa storage.objects aendres samtidig.
async function uploadOpgavefotos(klient, opgaveId, notatId, filer, onFremdrift) {
  const stier = [];
  for (let i = 0; i < filer.length; i++) {
    if (onFremdrift) onFremdrift(i + 1, filer.length);
    const blob = await komprimerBillede(filer[i]);
    const sti = `${opgaveId}/${notatId}-${i}.jpg`;
    const { error } = await klient.storage.from("opgavefotos").upload(sti, blob, {
      contentType: "image/jpeg",
      upsert: false,
    });
    // Stien er fast, saa ligger filen der allerede, ER billedet sendt. Det sker naar
    // forbindelsen falder ud efter uploaden men foer svaret naaede frem, og hun
    // proever igen. Det er en succes, ikke en fejl — upsert: true undgaas med vilje,
    // saa vi ikke ved et uheld overskriver et billede med et andet.
    const findesAllerede = error && (error.statusCode === "409"
      || error.statusCode === 409
      || /exists/i.test(error.message || ""));
    if (error && !findesAllerede) throw new Error(error.message);
    stier.push(sti);
  }
  return stier;
}

// Bucket'en er privat, fordi billederne er fra kundernes hjem. Derfor kan der ikke
// gemmes en fast URL noget sted — den skal signeres hver gang og udloeber af sig selv.
async function signeredeFotoUrls(klient, stier) {
  if (!stier || stier.length === 0) return [];
  const { data, error } = await klient.storage.from("opgavefotos").createSignedUrls(stier, 3600);
  if (error) return [];
  return (data || []).map((d) => d.signedUrl).filter(Boolean);
}

function nytId(praefiks) {
  return praefiks + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// To knapper og to skjulte felter, fordi det ene udelukker det andet:
// capture="environment" aabner kameraet med det samme, men slaar samtidig multivalg
// OG adgangen til kamerarullen fra — det gaelder baade iPhone og Android. Uden
// capture faar man systemets vaelger, hvor flere billeder kan markeres, men saa er
// der et ekstra tryk for at fotografere. Derfor begge dele, hver for sig.
function FotoVaelger({ filer, setFiler, farve, tr }) {
  const kamera = useRef(null);
  const galleri = useRef(null);

  // Billeder laegges oveni de allerede valgte. Ellers ville det andet billede
  // erstatte det foerste, og man kunne aldrig faa mere end ét med fra kameraet.
  function tilfoej(nye) {
    setFiler((prev) => [...prev, ...Array.from(nye || [])].slice(0, MAKS_FOTOS));
  }

  // Miniaturer af det der ligger klar. Object-URL'erne frigives naar listen aendrer
  // sig — ellers holder browseren fat i hvert eneste billede resten af besoeget.
  const [previews, setPreviews] = useState([]);
  useEffect(() => {
    const urls = filer.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [filer]);

  const fuldt = filer.length >= MAKS_FOTOS;
  const knap = { ...s.notatFotoBtn, borderColor: farve || "#E2E8F0", color: farve || "#111111" };

  return (
    <div>
      <input ref={kamera} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { tilfoej(e.target.files); e.target.value = ""; }} />
      <input ref={galleri} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={(e) => { tilfoej(e.target.files); e.target.value = ""; }} />

      {filer.length > 0 && (
        <div style={s.valgteRaekke}>
          {previews.map((url, i) => (
            <div key={url} style={{ position: "relative", flexShrink: 0 }}>
              <img src={url} alt="" style={s.valgtFoto} />
              <button type="button" style={s.fjernFoto} title="Fjern"
                onClick={() => setFiler((prev) => prev.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...knap, opacity: fuldt ? 0.45 : 1 }} disabled={fuldt}
          onClick={() => kamera.current?.click()}>
          📷 {tr.photoCamera}
        </button>
        <button type="button" style={{ ...knap, opacity: fuldt ? 0.45 : 1 }} disabled={fuldt}
          onClick={() => galleri.current?.click()}>
          🖼️ {tr.photoLibrary}
        </button>
      </div>
      <div style={s.fotoTaeller}>
        {fuldt ? tr.photoMax : `${filer.length}/${MAKS_FOTOS} ${tr.photoCount}`}
      </div>
    </div>
  );
}

function travelKey(a, b) { return [a, b].sort().join(" || "); }
function getTravelMinutes(addrA, addrB, settings) {
  if (!addrA || !addrB || addrA === addrB) return 0;
  return settings.overrides?.[travelKey(addrA, addrB)] ?? settings.defaultMinutes ?? 20;
}
function parseTimeToMinutes(str) {
  const [h, m] = (str || "07:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function computeDaySchedule(dayTasks, settings, employee) {
  // Opgaver med et aftalt klokkeslaet ligger foerst og i kronologisk raekkefoelge.
  // Resten fylder ud efter dem. Foer blev raekkefoelgen bestemt af den vilkaarlige
  // raekkefoelge opgaverne kom retur fra databasen.
  const timeOf = (t) => t.scheduled_time || t.scheduledTime || null;
  const sorted = [...dayTasks].sort((a, b) => {
    const at = timeOf(a), bt = timeOf(b);
    if (at && bt) return parseTimeToMinutes(at) - parseTimeToMinutes(bt);
    if (at) return -1;
    if (bt) return 1;
    return 0;
  });
  // Dagen starter ved medarbejderens egen moedetid hvis den er sat — praecis som
  // planlaeggeren regner. Ellers ved det generelle standardtidspunkt.
  let cursor = parseTimeToMinutes((employee && (employee.start_time || employee.startTime)) || settings.dayStart);
  const segments = [];
  // Er koerslen en del af hendes arbejdstid, begynder dagen hjemme. Moedetiden er saa
  // tidspunktet hvor hun tager hjemmefra — ikke hvor hun staar hos den foerste kunde.
  const hjemTaeller = !!(employee && employee.travel_in_worktime && employee.home_address);
  if (hjemTaeller && sorted.length > 0) {
    const ud = getTravelMinutes(employee.home_address, sorted[0].address, settings);
    if (ud > 0) {
      segments.push({ type: "transport", hjem: "ud", minutes: ud, start: cursor, key: "hjem-ud" });
      cursor += ud;
    }
  }
  sorted.forEach((t, idx) => {
    if (idx > 0) {
      const travel = getTravelMinutes(sorted[idx - 1].address, t.address, settings);
      if (travel > 0) {
        segments.push({ type: "transport", minutes: travel, start: cursor, key: `${sorted[idx-1].id}-${t.id}` });
        cursor += travel;
      }
    }
    // Et aftalt klokkeslaet er en aftale med kunden og skal staa fast. Tidligere
    // blev det kun brugt til at bestemme raekkefoelgen, saa en opgave aftalt til
    // kl. 11 blev vist fra arbejdsdagens start — medarbejderen fik altsaa et
    // andet tidspunkt end det planlaeggeren og kunden havde aftalt.
    const fixedRaw = timeOf(t);
    const fixed = fixedRaw ? parseTimeToMinutes(fixedRaw) : null;
    if (fixed !== null && fixed > cursor) cursor = fixed;
    segments.push({ type: "task", task: t, start: cursor });
    cursor += t.duration;
  });
  // Turen hjem, saa hun kan se hvornaar arbejdsdagen faktisk er slut.
  if (hjemTaeller && sorted.length > 0) {
    const hjem = getTravelMinutes(sorted[sorted.length - 1].address, employee.home_address, settings);
    if (hjem > 0) segments.push({ type: "transport", hjem: "hjem", minutes: hjem, start: cursor, key: "hjem-retur" });
  }
  return segments;
}

// Hvem staar oeverst paa opgaven — kunden eller borgeren?
//
// Det afhaenger af kontrakttypen, fordi "kunde" betyder to forskellige ting:
//
//   privat, erhverv   Kunden ER den hun besoeger. Fru Jensen eller Davidsen A/S
//                     staar paa doeren. Navnet oeverst, adressen under.
//
//   nexus, aeldrelov  Kunden er den der faar REGNINGEN. Arbejdet foregaar hjemme
//                     hos en borger, mens kundenavnet er "Jammerbugt Kommune" paa
//                     alle 548 opgaver. Stod kommunen oeverst, ville hvert kort se
//                     ens ud, og det ene felt hun skal bruge for at finde derhen
//                     stod med graat nedenunder.
//
// 22.9.2026: referencen paa nexus/aeldrelov-opgaver baerer borgerens fulde navn
// og paa nexus i praksis ogsaa cpr-nummeret FOERST i teksten — det staar der KUN
// til brug for fakturaen i Dinero, og cpr-nummeret hoerer aldrig hjemme paa en
// medarbejders skaerm. Navnet derimod skal hun bruge: adressen er ikke altid nok
// til at se HVILKEN af de mange ens Nexus/Ældrelov-opgaver hun kigger paa (flere
// borgere paa samme adresse, eller en akut tilkaldt opgave uden fast tid). Derfor
// vises referencen igen, men renset for nexus og som den er for aeldrelov (der
// staar aldrig et cpr-nummer i den).
const BETALER_ER_IKKE_STEDET = ["nexus", "aeldrelov"];
const KONTRAKTTYPE_LABEL = { nexus: "Nexus", aeldrelov: "Ældrelov" };
// Nexus-referencen er formet "DDMMYY-XXXX Fornavn Efternavn" af Dinero-eksporten.
// Kun det, der staar EFTER cpr-nummeret, maa vises.
const CPR_PRAEFIKS = /^\d{6}-\d{4}\s*/;

function opgaveIdentitet(t) {
  const kunde = (t.customerName || t.customer_name || "").trim();
  const reference = (t.reference || "").trim();
  const adresse = (t.address || t.address_text || "").trim();
  const type = t.contractType || t.contract_type || "privat";

  if (BETALER_ER_IKKE_STEDET.includes(type)) {
    // 22.9.2026, endnu en runde: adressen laa foerst i sekundaer, som kun vises
    // naar kortet i tidslinjen er hoejt nok (visLinje2). Er opgaven kort, forsvandt
    // linjen helt — og med "Nexus" alene paa linje 1 kunne hun ikke se HVILKEN af
    // de 548 ens opgaver hun kiggede paa. Adressen skal derfor med paa linje 1,
    // ikke kun linje 2, saa den altid er der, ogsaa paa et lavt kort.
    const maerke = KONTRAKTTYPE_LABEL[type] || "";
    const primaer = adresse ? (maerke ? `${maerke} · ${adresse}` : adresse) : maerke;
    const visReference = type === "nexus" ? reference.replace(CPR_PRAEFIKS, "").trim() : reference;
    return { primaer, sekundaer: visReference, kunde: visReference, kundeDaempet: true, adresse };
  }
  // Kunden er stedet. Referencen kan vaere en kontaktperson og staar under adressen.
  return { primaer: kunde || adresse, sekundaer: adresse,
           kunde: reference, kundeDaempet: true, adresse };
}

// ── Tidslinje for dagen ──────────────────────────────────────────────────────
//
// Samme segmenter som listen, men tegnet paa en klokkeslaets-skala. Beregningen er
// den samme - computeDaySchedule har allerede regnet start og varighed ud - saa de
// to visninger kan ikke komme til at vise forskellige tider.
//
// EN VIGTIG FORSKEL PAA DE TO. I listen laeser man tiderne som en raekkefoelge. Paa
// et gitter ligner et klokkeslaet et loefte, og 18 % af opgaverne har ikke et aftalt
// tidspunkt - deres tid er REGNET ud fra hvornaar dagen begynder og hvor lang tid
// det foregaaende tager. Skrider dagen, skrider de med.
//
// Derfor tegnes de to slags forskelligt: aftalt tid staar fast og fuldt optrukket,
// beregnet tid er stiplet og faar "ca." foran. Uden den forskel ville en medarbejder
// love en kunde et tidspunkt, systemet aldrig har lovet hende.
// Farver pr. status. Samme betydning som i listen, men daempet — paa et gitter
// ligger blokkene taet, og maettede farver ville goere dagen ulaeselig.
const STATUS_FARVER = {
  planlagt:    { bag: "#EFF6FF", kant: "#3B82F6", tekst: "#1E3A8A" },
  i_gang:      { bag: "#FFFBEB", kant: "#D97706", tekst: "#78350F" },
  "udført":    { bag: "#F0FDF4", kant: "#16A34A", tekst: "#14532D" },
  unscheduled: { bag: "#F8FAFC", kant: "#94A3B8", tekst: "#334155" },
};

const PX_PR_MIN = 1.7;

function Tidslinje({ schedule, employee, lang, erIDag, onVaelg }) {
  const da = lang === "da";
  const [nu, setNu] = useState(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });

  // Nu-linjen skal flytte sig af sig selv. Uden det staar den stille, til nogen
  // aabner appen igen - og saa er den forkert netop naar man kigger paa den.
  useEffect(() => {
    if (!erIDag) return;
    const t = setInterval(() => {
      const d = new Date();
      setNu(d.getHours() * 60 + d.getMinutes());
    }, 60000);
    return () => clearInterval(t);
  }, [erIDag]);

  if (!schedule.length) return null;

  const slut = (seg) => seg.start + (seg.type === "task" ? (seg.task.duration || 0) : seg.minutes);
  const foerste = Math.min(...schedule.map((x) => x.start));
  const sidste = Math.max(...schedule.map(slut));

  // Hele timer i begge ender, saa skalaen har pæne streger at hænge paa.
  const fraTime = Math.floor(foerste / 60);
  const tilTime = Math.ceil(sidste / 60);
  const fra = fraTime * 60;
  const hoejde = (tilTime - fraTime) * 60 * PX_PR_MIN;
  const timer = [];
  for (let t = fraTime; t <= tilTime; t++) timer.push(t);

  const tidOf = (t) => t.scheduled_time || t.scheduledTime || null;

  return (
    <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
      {/* Klokkeslaets-skalaen */}
      <div style={{ width: 42, flexShrink: 0, position: "relative", height: hoejde }}>
        {timer.map((t) => (
          <div key={t} style={{ position: "absolute", top: (t * 60 - fra) * PX_PR_MIN - 7,
                                right: 6, fontSize: 11.5, color: "#94A3B8" }}>
            {String(t).padStart(2, "0")}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, position: "relative", height: hoejde,
                    borderLeft: "1px solid #E2E8F0" }}>
        {timer.map((t) => (
          <div key={t} style={{ position: "absolute", left: 0, right: 0,
                                top: (t * 60 - fra) * PX_PR_MIN,
                                borderTop: "1px solid #F1F5F9" }} />
        ))}

        {schedule.map((seg) => {
          const top = (seg.start - fra) * PX_PR_MIN;
          if (seg.type === "transport") {
            const h = Math.max(seg.minutes * PX_PR_MIN, 14);
            return (
              <div key={seg.key} title={da ? "Kørsel" : "Travel"}
                style={{ position: "absolute", left: 6, right: 8, top, height: h,
                         display: "flex", alignItems: "center", gap: 5,
                         background: "repeating-linear-gradient(45deg,#F8FAFC,#F8FAFC 5px,#F1F5F9 5px,#F1F5F9 10px)",
                         borderRadius: 5, padding: "0 7px", overflow: "hidden" }}>
                <Car size={11} color="#94A3B8" />
                <span style={{ fontSize: 10.5, color: "#94A3B8", whiteSpace: "nowrap" }}>
                  {fmtMin(seg.minutes)}
                </span>
              </div>
            );
          }

          const t = seg.task;
          const ident = opgaveIdentitet(t);
          const aftalt = !!tidOf(t);
          const h = Math.max((t.duration || 0) * PX_PR_MIN, 34);

          // Fuldfoert betyder HENDES flueben — ikke opgavens status.
          // Tidslinjen farvede efter t.status, og det er ikke det samme: paa en
          // opgave to medarbejdere deler, staar status stadig 'planlagt' indtil
          // begge er faerdige. Hun kunne altsaa have meldt sig faerdig og stadig
          // se en bla blok. Listen har hele tiden brugt completed_by_employee.
          // ?. med vilje: en tidslinje uden profil skal vise dagen uden flueben,
          // ikke give hvid skaerm midt i en arbejdsdag.
          const gjort = !!((t.completed_by_employee || {})[employee?.id]);
          const st = gjort
            ? STATUS_FARVER["udført"]
            : (STATUS_FARVER[t.status] || STATUS_FARVER.planlagt);

          // Samme tal som paa kortet i listen, regnet paa samme maade.
          const minLogget = (t.timeLog || [])
            .filter((l) => l.empId === employee?.id)
            .reduce((sum, l) => sum + (l.minutes || 0), 0);
          const tjekGjort = (t.checklist || []).filter((i) => i.done).length;
          const tjekIalt  = (t.checklist || []).length;
          const maerke = t.contractType === "nexus" ? { tekst: "Nexus", farve: "#4F46E5", bag: "#EEF2FF" }
                       : t.contractType === "aeldrelov" ? { tekst: "Ældrelov", farve: "#C2410C", bag: "#FFF7ED" }
                       : t.contractType === "privat" ? { tekst: da ? "Privat" : "Private", farve: "#9C1B5D", bag: "#FFF6FA" }
                       : null;
          // Hvor meget der er plads til. En kvarters opgave er 34 px hoej — der er
          // kun plads til én linje, og saa skal det vaere klokkeslaet og hvem.
          const visLinje2 = h > 46;
          const visLinje3 = h > 74;
          const smaaMaerker = [];
          if (tjekIalt > 0) smaaMaerker.push({ ikon: <ListChecks size={10} />, tekst: `${tjekGjort}/${tjekIalt}` });
          if (minLogget > 0) smaaMaerker.push({ ikon: <Clock size={10} />, tekst: fmtMin(minLogget) });
          return (
            <div key={t.id} style={{ position: "absolute", left: 6, right: 8, top, height: h }}>
            <button onClick={() => onVaelg(t)}
              style={{ position: "absolute", inset: 0,
                       textAlign: "left", padding: "5px 9px", cursor: "pointer",
                       background: st.bag, color: st.tekst,
                       borderRadius: 7, overflow: "hidden",
                       border: aftalt ? `1px solid ${st.kant}` : `1px dashed ${st.kant}`,
                       borderLeft: `4px solid ${st.kant}`,
                       // Plads i hoejre side til navigationsikonet, saa teksten ikke
                       // loeber ind under det.
                       paddingRight: ident.adresse ? 34 : 9 }}>
              {/* Samme prioritering som paa kortet: hvem og hvor, ikke hvem der
                  betaler. Med kundenavnet foerst stod der "Jammerbugt Kommune" paa
                  hver eneste blok, og dagen kunne ikke laeses. */}
              {/* Fluebenet staar foerst paa linjen. Farven alene er ikke nok:
                  groen og blaa ligner hinanden paa en telefon i sollys, og
                  farveblinde ser ingen forskel. Samme ikon som i listen. */}
              <div style={{ fontSize: 12.5, fontWeight: 700, display: "flex",
                            alignItems: "center", gap: 4, minWidth: 0 }}>
                {gjort && <CheckCircle2 size={13} style={{ flexShrink: 0 }} />}
                {/* Noeglen staar paa foerste linje, ogsaa naar blokken er for lav
                    til andet. En kvarters opgave man koerer 30 km til uden noeglen
                    er en spildt tur — det maa aldrig vaere det, der klippes vaek.
                    Teksten «Hent nøgle» staar paa tredje linje, naar der er plads. */}
                {t.needsKeyPickup && <Key size={12} style={{ flexShrink: 0 }} />}
                <span style={{ whiteSpace: "nowrap", overflow: "hidden",
                               textOverflow: "ellipsis", minWidth: 0 }}>
                  {aftalt ? fmtClock(seg.start) : `ca. ${fmtClock(seg.start)}`} ·{" "}
                  {ident.primaer || t.title}
                </span>
              </div>

              {visLinje2 && (
                <div style={{ fontSize: 11, opacity: 0.85, whiteSpace: "nowrap",
                              overflow: "hidden", textOverflow: "ellipsis" }}>
                  {ident.sekundaer ? `${ident.sekundaer} · ` : ""}{fmtMin(t.duration || 0)}
                </div>
              )}

              {/* Tredje linje kun naar blokken er hoej nok. Presses de ind paa en
                  kort opgave, klippes klokkeslaettet af — og det er det vigtigste. */}
              {visLinje3 && (t.needsKeyPickup || smaaMaerker.length > 0 || maerke || ident.kunde) && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2,
                              flexWrap: "nowrap", overflow: "hidden" }}>
                  {/* Foerst i raekken, saa det er betaleren der klippes af og ikke
                      noeglen. Ikonet paa foerste linje er sikkerhedsnettet — det her
                      er teksten, der siger hvad ikonet betyder. */}
                  {t.needsKeyPickup && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 2,
                                   fontSize: 9.5, fontWeight: 700, color: "#92400E",
                                   background: "#FEF3C7", borderRadius: 6,
                                   padding: "1px 5px", flexShrink: 0 }}>
                      <Key size={9} />{da ? "Hent nøgle" : "Key"}
                    </span>
                  )}
                  {smaaMaerker.map((m, i) => (
                    <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2,
                                           fontSize: 10, fontWeight: 600, opacity: 0.9,
                                           flexShrink: 0 }}>
                      {m.ikon}{m.tekst}
                    </span>
                  ))}
                  {maerke && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: maerke.farve,
                                   background: maerke.bag, borderRadius: 6,
                                   padding: "1px 5px", flexShrink: 0 }}>{maerke.tekst}</span>
                  )}
                  {/* Den der betaler — ikke den hun besoeger. Nederst, som i listen. */}
                  {ident.kunde && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 2,
                                   fontSize: 10, opacity: 0.7, minWidth: 0,
                                   whiteSpace: "nowrap", overflow: "hidden",
                                   textOverflow: "ellipsis" }}>
                      <Building2 size={10} style={{ flexShrink: 0 }} />{ident.kunde}
                    </span>
                  )}
                </div>
              )}
            </button>
            {/* Naviger direkte fra tidslinjen. Blokken er for smal til en knap med
                tekst, saa det er et ikon — men trykfladen er 30x30, saa den kan
                rammes med en finger uden at aabne opgaven ved et uheld. */}
            {ident.adresse && (
              <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ident.adresse)}`}
                target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                aria-label={da ? "Kør derhen" : "Navigate"} title={da ? "Kør derhen" : "Navigate"}
                style={{ position: "absolute", right: 3, top: 3, width: 30, height: 30,
                         display: "flex", alignItems: "center", justifyContent: "center",
                         borderRadius: 7, background: "rgba(255,255,255,0.75)",
                         color: st.kant, textDecoration: "none" }}>
                <Navigation size={14} />
              </a>
            )}
            </div>
          );
        })}

        {/* Nu-linjen. Kun paa dagen i dag, og kun naar den er inden for skalaen —
            ellers ville den klistre til toppen om morgenen og til bunden om aftenen
            og se ud som om klokken stod stille. */}
        {erIDag && nu >= fra && nu <= tilTime * 60 && (
          <div style={{ position: "absolute", left: -4, right: 0,
                        top: (nu - fra) * PX_PR_MIN, height: 0,
                        borderTop: "2px solid #D6247A", zIndex: 2 }}>
            <div style={{ position: "absolute", left: -3, top: -4, width: 8, height: 8,
                          borderRadius: "50%", background: "#D6247A" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Language selector ─────────────────────────────────────────────────────────

// ── Hjælpeside ────────────────────────────────────────────────────────────────
// Samme indhold som den trykte brugervejledning, men bygget til telefon:
// fuld skærm, store trykflader og korte afsnit man kan skimme med én hånd.
const HELP_DA = [
  { t: "Er du ny? Start her", p: [
    "Første gang du åbnede appen, kom der tre skærmbilleder. Vil du se dem igen, står knappen «Vis introduktionen igen» øverst her på siden.",
    "Ved siden af står «Øv dig på en prøvedag». Det er en hel arbejdsdag med fire opgaver, hvor ingenting er rigtigt: der er ingen borgere, ingen kunder, og der bliver ikke gemt noget nogen steder.",
    "Du må tage prøvedagen så mange gange, du vil. Ingen kan se, hvor mange gange du har gjort det.",
    "Er der noget, du ikke kan finde ud af, så ring til kontoret. Det er ikke dumt at spørge — appen er ny for alle.",
  ] },
  { t: "De fire knapper i toppen", p: [
    "Øverst til højre står fire knapper. De er der hele dagen, uanset hvor i appen du er.",
    "T-shirten er arbejdstøj. Her bestiller du bukser, T-shirts og sko, og kontoret får besked.",
    "Bilen er din kørsel. Kilometrene regnes ud af sig selv ud fra de opgaver, du melder færdige — du skal ikke skrive noget.",
    "Spørgsmålstegnet er den her side.",
    "Cirklen med dine bogstaver er dig selv: sprog, liste eller tidslinje, beskeder på telefonen, og log ud.",
    "Der kan komme to knapper mere. Et gult udråbstegn betyder, at du mangler at registrere tid på en dag, der er gået — tallet siger hvor mange. En kalender vises kun, hvis du også planlægger.",
  ] },
  { t: "Sådan finder du derhen", p: [
    "På hver opgave står adressen med det samme — du behøver ikke åbne opgaven for at se, hvor du skal hen.",
    "Er det en kommunal opgave, står borgerens navn øverst og adressen under. Firmanavnet nederst er den, der får regningen — ikke den du skal besøge.",
    "Tryk «Kør derhen», så åbner kortet med ruten. På tidslinjen er det pilen i hjørnet af opgaven.",
    "Det åbner dit almindelige kortprogram. Du kommer tilbage til Worklist ved at skifte tilbage — du bliver ikke logget ud.",
  ] },
  { t: "Dine indstillinger", p: [
    "Tryk på dit navn øverst for at åbne dine indstillinger. De fylder hele skærmen, og du lukker dem med krydset i hjørnet.",
    "Under hvert punkt står, hvad der er valgt lige nu — du behøver ikke åbne noget for at se det.",
    "Her vælger du, om dagen skal vises som tidslinje eller liste, hvilket sprog appen taler, og om du vil have beskeder på telefonen.",
    "Appen taler dansk og engelsk. Første gang følger den din telefon: er telefonen på dansk, får du dansk — ellers engelsk. Vælger du selv, følger valget dig, også hvis du skifter telefon.",
    "Du kan også bede om et link til at skifte adgangskode. Det bliver sendt til din mail.",
    "Log ud står nederst for sig selv. Du behøver ikke logge ud, når du er færdig for dagen — appen husker dig.",
  ] },
  { t: "Liste eller tidslinje", p: [
    "Dagen vises som en tidslinje med klokkeslæt ned ad siden. Vil du hellere have opgaverne som en almindelig liste, kan du skifte i dine indstillinger — tryk på dit navn øverst.",
    "Tidslinjen viser dagen som en kalender: hvor længe hver opgave tager, og hvor meget kørsel der er imellem. En rød streg viser, hvad klokken er nu.",
    "Har du meldt en opgave færdig, bliver blokken grøn og får et flueben. Er der plads i blokken, står også din registrerede tid, tjeklisten, om nøglen skal hentes på kontoret, og hvem der får regningen — det samme som på listen.",
    "Korte opgaver har kun plads til klokkeslæt og navn. Åbn opgaven for at se resten.",
    "Er kanten om en opgave fuldt optrukket, er tidspunktet aftalt med kunden. Er den stiplet, og står der «ca.», er tidspunktet regnet ud fra hvornår din dag begynder — skrider dagen, skrider det med.",
    "Lov aldrig en kunde et «ca.»-tidspunkt. Ring til kontoret, hvis kunden skal have en fast tid.",
    "Dit valg huskes til næste gang du åbner appen. Skifter du telefon, står den på tidslinje igen.",
  ] },
  { t: "Beskeder på telefonen", p: [
    "Appen kan give dig besked, når du mangler at registrere tid, når din plan bliver ændret, og når kontoret har svaret på et ønske om ny tid.",
    "Første gang står der et banner øverst på dagen med en knap. Trykker du på den, er de slået til, og banneret forsvinder.",
    "Har du allerede sagt ja på en anden telefon, tilmeldes den nye af sig selv, når du logger ind.",
    "Du kan altid slå dem til eller fra i dine indstillinger — tryk på dit navn øverst.",
    "Har du en iPhone, skal appen først ligge på hjemmeskærmen. Tryk på Del-knappen nederst i Safari, vælg «Føj til hjemmeskærm», og åbn Worklist derfra. Uden det kan iPhone ikke give dig beskeder — det er Apple der bestemmer det, ikke os.",
    "Beskeder om ændringer i planen samles og kommer højst hvert kvarter. Retter kontoret flere ting på én gang, får du én besked og ikke ti.",
    "Om aftenen får du en besked om, hvad der venter i morgen.",
    "Du får stadig de samme mails som før. Slår du beskeder fra igen, sker det samme sted.",
  ], warn: "Skifter du telefon, skal du slå beskeder til igen på den nye. Den gamle holder op af sig selv." },
  { t: "Hvis der er et problem", p: [
    "Nederst på opgaven står «Der er et problem». Tryk på den, så får du en skærm med to muligheder — du skal ikke scrolle efter noget.",
    "«Foreslå ny tid» bruger du, når du har aftalt et nyt tidspunkt med kunden. Opgaven bliver stående hos dig, indtil kontoret har flyttet den — den forsvinder ikke, fordi du har sendt ønsket. Kan det ikke lade sig gøre, får du en mail med begrundelsen, og så skal du ringe til kunden igen.",
    "«Kunne ikke komme ind» bruger du, når ingen svarede, nøglen ikke passede, eller døren var låst. Skriv hvad der skete, og tag gerne et billede af døren eller nøgleboksen.",
    "Ved «kunne ikke komme ind» kan du foreslå en ny dato hvis du allerede ved hvornår du kan komme igen. Det er frivilligt.",
    "Kontoret får besked med det samme i begge tilfælde og afgør, om kunden skal betale for turen. Det er ikke noget du skal tage stilling til.",
    "Registrér ikke tid på opgaven som om den var udført. Meld den i stedet."] },
  { t: "Kommentar og billeder", p: [
    "På alle opgaver kan du skrive en kommentar til kontoret og tage billeder. Du finder det inde i opgaven under «Kommentar og billeder».",
    "Brug det når noget skal dokumenteres: der var meget mere beskidt end normalt, noget var i stykker, eller kunden har bedt om noget ekstra.",
    "Der er to knapper. «Tag billede» åbner kameraet og tager ét billede ad gangen — tryk bare igen for det næste, de lægges oveni hinanden.",
    "«Fra galleri» åbner telefonens billeder, og der kan du markere flere på én gang. Det virker både på iPhone og Android.",
    "Du kan have op til ti billeder klar. Tælleren under knapperne viser hvor mange du har. Fortryder du et, så tryk × i hjørnet af det.",
    "Skriv gerne en linje om hvad man ser — et billede uden tekst er svært for kontoret at bruge.",
    "Sender du mange billeder, tæller knappen dem op undervejs — vent til den er færdig, og tryk ikke igen.",
    "Billederne bliver mindre af sig selv, før de sendes, så det virker også på dårligt mobilnet.",
    "Kontoret kan se det hele, når de laver fakturaen. Billederne slettes automatisk efter 12 måneder."] },
  { t: "Sådan finder du dine opgaver", p: [
      "Når du åbner appen, ser du denne uge. Øverst vælger du dag.",
      "Tallet i den lille boble på dagen viser, hvor mange opgaver du har.",
      "Pilene skifter uge. «I dag» hopper tilbage til dagens dato.",
      "«+ Weekend» viser lørdag og søndag, hvis du har vagter der.",
      "Tryk på opgaven for at åbne den." ] },
  { t: "Inde i opgaven — mens du arbejder", p: [
      "Skærmen viser kun det du skal bruge for at gøre arbejdet: kunden, adressen, hvordan du kommer ind, og hvad der skal gøres.",
      "«Vis vej» åbner Google Maps.",
      "Under «Adgang» trykker du for at se nøgleboks og kode — se afsnittet nedenfor.",
      "Under «Tasks» sætter du flueben, når du har gjort en ting. Tælleren viser hvor langt du er.",
      "Der skal ikke registreres noget her. Det kommer bagefter." ] },
  { t: "Nøglebokskoder og adgang", p: [
      "Koderne er skjulte, indtil du selv trykker «Vis adgangsoplysninger». Det er ikke fordi vi ikke stoler på dig — det er fordi koderne hører til kundernes hjem, og vi skal kunne dokumentere hvem der har set dem.",
      "Når du åbner dem, registreres det med dit navn og tidspunktet. Det står på knappen inden du trykker.",
      "Åbn dem gerne så tit du har brug for det. Der er ingen grænse, og du skal ikke spørge om lov.",
      "Står der «Hent nøgle/adgangskort på kontoret» på opgaven i dagslisten, skal du forbi kontoret først. Så er der ingen kode — den ligger og venter på dig." ] },
  { t: "Når du er færdig — «Afslut opgave»", p: [
      "Nederst på skærmen står «Afslut opgave». Den knap er der altid, også hvis du har scrollet ned i en lang liste.",
      "Så bliver du ledt gennem nogle få spørgsmål, ét ad gangen. Øverst kan du se hvor langt du er — fx «1 af 3».",
      "Til sidst får du en kvittering med det du har registreret. Så ved du at det er gemt, og du behøver ikke ringe til kontoret for at spørge.",
      "Har du glemt noget, kan du åbne opgaven igen og afslutte igen. Tiden bliver lagt oveni den du allerede har registreret — den bliver ikke overskrevet.",
      "Arbejder I to på samme opgave, afslutter I hver for sig med hver jeres tid." ], warn:
      "Husk at afslutte samme dag. Registrerer du ikke din tid, bliver din kørsel ikke beregnet — og så får du ikke kørselspenge for turen. Hver dag kl. 18 får du en mail, hvis du mangler noget." },
  { t: "Trin 1 — hvor lang tid brugte du?", p: [
      "Feltet er sat til den tid der er afsat til dig. Passer det, trykker du bare «Videre» uden at ændre noget.",
      "Er I flere på opgaven, gælder tiden pr. person. Er der sat 1 time af og I er to, er der afsat 2 timer i alt — du skal kun skrive din egen tid, og du får ikke besked om overskridelse fordi din kollega også har registreret.",
      "Skal det rettes, er der to rækker med − og + : øverst timer, nederst minutter. Knapperne går i spring af 5 minutter.",
      "Du kan også trykke på selve tallet og skrive det, du vil — også 18 minutter eller andre tal, knapperne ikke rammer. Tiden skal passe med det, du faktisk har brugt.",
      "Det store tal foroven er det du registrerer i alt. Under det står om det passer med det planlagte.",
      "Brugte du længere tid end afsat, skal du skrive hvorfor. Det er ikke en løftet pegefinger — kontoret skal kunne forklare det til kunden.",
      "Har du fortrudt en afslutning og åbner opgaven igen — fx for at tilføje et billede — står der 0, og det er helt i orden. Din tid er registreret i forvejen, og du skal ikke taste mere for at komme videre." ] },
  { t: "Produkter til kunden", p: [
      "Produkter henter du på kontoret. Planlæggeren skriver ned hvad du har fået med, og til hvilken kunde. Du skal ikke selv vælge noget i appen.",
      "Har du varer med til en kunde, kommer der et ekstra trin når du afslutter en opgave hos netop den kunde. Der står hvad du fik med, og du svarer ja eller nej til om kunden har fået det.",
      "Det er lige meget hvilken opgave hos kunden du står på — udleveringen følger dig og kunden, ikke en bestemt dag. Bliver opgaven flyttet, følger den med.",
      "Siger du nej, bliver varerne stående hos dig og dukker op igen næste gang du er hos kunden. Kunden får først en regning for dem når du har sagt ja.",
      "Bliver du ikke spurgt, har du ingen varer med til den kunde. Så er der ét trin mindre, og tælleren øverst siger fx «1 af 2»." ] },
  { t: "Det du mangler", p: [
      "Mangler du at registrere tid eller markere en opgave som udført, kommer der et gult udråbstegn øverst med et tal. Tallet er antallet af opgaver, der ikke er gjort færdige.",
      "Tryk på det, og du får hele listen — også opgaver fra tidligere uger, som du ellers skulle bladre tilbage for at finde. Ældste står øverst, for det er dem, der er tættest på at gå tabt.",
      "Tryk på en opgave i listen, så åbner den, og du kan registrere og afslutte med det samme. Den forsvinder fra listen, og tallet tæller ned.",
      "Du kommer altid tilbage til listen bagefter — også hvis du fortryder og hellere vil tage en anden først. Så kan du arbejde dig ned gennem den uden at lede efter udråbstegnet hver gang.",
      "Er der intet udråbstegn, mangler du ingenting. Det er den samme opgørelse, som påmindelsesmailen kl. 18 bruger — de kan ikke komme til at sige hver sit.",
      "Til kontoret: vælger du en kollega under «Se plan for», viser udråbstegnet hendes tal og hendes liste, så I kan hjælpe hende over telefonen. Det er kun visning — I kan ikke registrere for hende.",
      "Husk: når måneden lukker, kan timer og kørsel fra den måned ikke længere komme med på lønnen." ] },
  { t: "Nexus-borgere", p: [
      "Er opgaven hos en Nexus-borger, står det øverst på opgaven, og der er en knap til at åbne KMD Nexus.",
      "Når du afslutter, kommer der et ekstra trin hvor du bliver mindet om at kvittere i Nexus. Kommunen betaler efter det der står i Nexus — ikke efter det du skriver her.",
      "Har du kvitteret, sætter du fluebenet. Kunne du ikke komme i Nexus, så lad det stå tomt — du kan afslutte alligevel, og kontoret følger op." ] },
  { t: "Bestil arbejdstøj", p: [
      "Tryk på trøje-ikonet øverst.",
      "Sæt antal med + og − og tryk «Vælg produkter».",
      "Din bestilling går til kontoret, som godkender den. Under «Historik» ser du dine tidligere bestillinger." ] },
  { t: "Når der ikke er dækning", p: [
      "Appen gemmer ugens opgaver på telefonen, så du kan se dagens liste selv i en kælder eller et sommerhusområde uden signal.",
      "Er der ikke forbindelse, kommer der et gult bånd øverst: «Gemt kopi — ingen forbindelse», og hvornår den blev hentet. Så ved du at en ændring kontoret har lavet i mellemtiden ikke er med.",
      "Båndet forsvinder af sig selv når du har dækning igen, og listen bliver hentet forfra.",
      "Du kan godt afslutte en opgave uden dækning. Tid, flueben, kommentar og billeder bliver lagt i kø og sendt af sig selv når du har forbindelse igen.",
      "Venter der noget, står der et gult bånd øverst: «2 registreringer venter på dækning». Det forsvinder når alt er sendt.",
      "Vigtigt: luk ikke appen helt ned mens der står noget i køen. Den kan kun sende mens appen er åben. Kommer du i tvivl, så åbn appen igen når du har dækning — så sender den selv.",
      "Logger du ud mens der står noget i køen, går det tabt. Appen spørger først.",
      "Adgangsoplysninger hentes med den blå knap øverst, mens du har dækning — helst inden du kører hjemmefra. De gemmes til i nat og slettes så. Står du ved en låst dør uden signal og uden at have hentet dem, så ring til kontoret.",
      "For at det virker skal appen ligge på hjemmeskærmen. På iPhone: tryk på del-ikonet nederst og vælg «Føj til hjemmeskærm». Gør du det ikke, rydder telefonen det gemte efter en uge." ] },
  { t: "Kundemøder og tilbud", p: [
      "Dette afsnit gælder kun planlæggere. Er du ikke planlægger, ser du hverken knappen eller møderne.",
      "Tryk på kalender-ikonet øverst for at booke et kundemøde. Kunden behøver ikke findes i Dinero endnu.",
      "Mødet lægges i din uge, så kontoret kan se at du er ude, og tiden tæller i din kapacitet.",
      "Åbn mødet når du er derude. Du får tilbudsskærmen i stedet for den almindelige opgave: referat, billeder, pris og hvilke ydelser der er med.",
      "Referatet er lavet til at blive dikteret. Tryk på mikrofonen på tastaturet og tal — ret det bagefter.",
      "Du kan lægge op til 10 billeder på. De er interne, medmindre du på tilbuddet vælger at vise dem til kunden.",
      "«Send til kunden» danner PDF'en og mailer et link hun kan acceptere fra. Accepterer hun, dannes aftalen som kladde — du sætter selv startdato og ugedage." ] },
  { t: "Dine timer — de tre tal", p: [
      "Tryk på bil-ikonet øverst. Under fanen Timer kan du se, hvad der bliver rapporteret til løn.",
      "Der står tre tal, og de er ikke det samme. «Planlagt» er den tid, kontoret afsatte til opgaven. «Registreret» er den tid, du selv har trykket. «Til løn» er det, kontoret har godkendt.",
      "Kun godkendte timer kommer med i lønfilen. Det er derfor, «Til løn» kan være mindre end «Registreret» — dine timer er ikke væk, kontoret har bare ikke set dem igennem endnu.",
      "Står der «Ingen tid registreret» ved en opgave, mangler du at registrere. Gør det, inden måneden lukkes — uden registreret tid bliver der ikke udbetalt for opgaven.",
      "«Heraf weekend» er de timer, der udløser weekendtillæg, hvis du er på den ordning.",
      "Med pilene øverst kan du gå tilbage i tiden. Du kan se denne måned og elleve måneder tilbage.",
      "Passer et tal ikke med det, du husker, så tag fat i kontoret med datoen og opgaven. Så kan I kigge på det samme.",
      "Er I flere på en opgave, kan kontoret have fordelt timerne ulige. Den tid der foreslås, når du afslutter, er DIN andel — ikke hele opgavens.",
      "Er du med på en opgave for at lære, står det på opgaven. Registrér din tid som altid — den tæller på din løn præcis som alt andet. Det er kun kundens faktura, den ikke går på.",
      "Er du planlægger og har valgt en kollega under «Se plan for», viser siden hendes tal og ikke dine. Hendes navn står i overskriften, og der er en orange bjælke øverst.",
    ] },
  { t: "Din kørsel", p: [
      "Under fanen Kørsel — samme sted som timerne — ser du din beregnede kørsel.",
      "Også her står der, om turen er godkendt til udbetaling, og hvor mange kilometer der er godkendt i alt.",
      "Satsen pr. kilometer sættes i lønsystemet og står ikke i appen. Den ændres ved lov hvert år.",
      "Har kontoret lagt en aktivitet ind med kørsel — fx at hente materialer — står turen her som sine egne linjer. Er det tur/retur, står ud og hjem hver for sig.",
      "Du skal ikke selv taste kilometer — det regnes ud fra dine opgaver, når du har registreret din tid.",
      "Har du kørsel med i din arbejdstid, står der «Kørsel hjemmefra» øverst på dagen og «Kørsel hjem» nederst. Klokkeslættet øverst er altså hvornår du tager hjemmefra, ikke hvornår du skal være hos den første kunde.",
      "Ser du ikke de to linjer, er du ikke på den ordning, og din kørsel afregnes med kilometerpenge i stedet. Spørg kontoret hvis du er i tvivl om hvad der gælder for dig." ] },
  { t: "Hvis noget driller", p: [
      "Kan du ikke logge ind? Tjek din e-mail og brug «Glemt adgangskode?».",
      "Kan du ikke se dine opgaver? Tjek at du står på den rigtige uge og dag.",
      "Mangler der en opgave? Kontakt kontoret — de kan flytte den.",
      "Hænger appen? Luk siden og åbn den igen." ] },
  // Privatlivspolitikken staar til sidst, men den er ikke en fodnote. Den er skrevet
  // ud fra de felter, der faktisk findes i databasen — ikke ud fra en skabelon. Aendrer
  // vi, hvad appen gemmer, skal den her tekst rettes i samme ombaering.
  { t: "Dine personoplysninger", p: [
      "Jammerbugt Rengøring er ansvarlig for de oplysninger, appen gemmer om dig. Her står præcis hvad det er.",
      "Om dig selv: dit navn, din arbejdsmail, dit sprogvalg, hvornår du normalt møder, dine kompetencer og hvilke områder du dækker.",
      "Din hjemmeadresse, hvis du er på en ordning hvor kørsel hjemmefra tæller med. Den bruges kun til at regne afstanden til dagens første opgave — ikke til andet.",
      "Om dit arbejde: hvilke opgaver du er sat på, hvornår du har registreret tid, hvor lang tid, og de beskeder du sender til kontoret.",
      "Om din løn: din timeløn og tidligere satser, bonus og kilometersats, om du har weekendtillæg og SH-betaling, og dit medarbejdernummer i Danløn.",
      "Fravær registreres som fravær. Der står aldrig hvorfor du var væk.",
      "Slår du beskeder til, gemmes en teknisk adresse på din telefon, så beskeden kan finde frem.",
    ] },
  { t: "Det appen ikke gemmer", p: [
      "Appen følger dig ikke. Der er ingen GPS og ingen positionsmåling — hverken i arbejdstiden eller udenfor. Kørslen regnes ud fra adresserne på dine opgaver, ikke fra hvor telefonen har været.",
      "Der ligger intet CPR-nummer i systemet. Lønfilen bruger dit Danløn-nummer.",
      "Der ligger ingen bankoplysninger og intet kontonummer.",
      "Der ligger ingen helbredsoplysninger, diagnoser eller sygdomsårsager.",
    ] },
  { t: "Hvem kan se hvad", p: [
      "Kontoret kan se dine opgaver, din registrerede tid og din løn. Det skal de for at kunne planlægge og udbetale.",
      "Dine kolleger kan ikke se din løn, dine noter eller dine adgangskoder. Det er ikke bare skjult på skærmen — databasen afviser det.",
      "Uden for huset: databasen ligger hos Supabase i Stockholm. Mails sendes gennem Brevo i Frankrig. Beregningen af afstande sker hos et tysk ruteberegningsfirma og hos statens adresseregister, som får adressen men ikke dit navn.",
      "Beskeder på telefonen går gennem Apple og Google. Indholdet er krypteret undervejs — de kan ikke læse, hvad der står.",
      "Lønfilen sendes ikke automatisk nogen steder. Kontoret henter den som en fil og lægger den selv op i Danløn.",
    ] },
  { t: "Hvor længe, og dine rettigheder", p: [
      "Stopper du, slettes dit login og din arbejdsmail med det samme, og du bliver logget ud af alle telefoner.",
      "Dit navn og dokumentationen for løn og kørsel bliver stående. Den skal kunne fremvises år efter — også hvis du selv får brug for den.",
      "Billeder på opgaver slettes automatisk efter 12 måneder. Adgangskoder til kundernes hjem slettes tre måneder efter, at opgaven er afsluttet.",
      "Du har ret til at se, hvad vi har om dig, og til at få rettet noget der er forkert. Spørg kontoret.",
      "Beskeder på telefonen slår du selv til og fra under dine indstillinger.",
    ] },
];
const HELP_EN = [
  { t: "New here? Start here", p: [
    "The first time you opened the app you saw three screens. To see them again, use «Show the intro again» at the top of this page.",
    "Next to it is «Practise on a test day». It is a full working day with four jobs where nothing is real: no citizens, no customers, and nothing is saved anywhere.",
    "Take the test day as many times as you like. Nobody can see how many times you have done it.",
    "If something is unclear, call the office. Asking is not silly — the app is new to everyone.",
  ] },
  { t: "The four buttons at the top", p: [
    "There are four buttons in the top right. They stay there all day, wherever you are in the app.",
    "The T-shirt is work clothing. Order trousers, T-shirts and shoes here, and the office is notified.",
    "The car is your driving. The kilometres are worked out on their own from the jobs you finish — you do not have to write anything.",
    "The question mark is this page.",
    "The circle with your initials is you: language, list or timeline, notifications, and sign out.",
    "Two more buttons can appear. A yellow warning sign means you have not registered time on a day that has passed — the number says how many. A calendar only shows if you are also a planner.",
  ] },
  { t: "Finding your way there", p: [
    "The address is shown on every job — you do not have to open the job to see where to go.",
    "On municipal jobs the resident's name is at the top and the address below. The company name at the bottom is the one being invoiced, not the one you visit.",
    "Tap “Navigate” to open the map with the route. On the timeline it is the arrow in the corner of the job.",
    "It opens your usual map app. Switch back to return to Worklist — you are not signed out.",
  ] },
  { t: "Your settings", p: [
    "Tap your name at the top to open your settings. They fill the screen, and you close them with the cross in the corner.",
    "Under each item you can see what is currently selected — you do not have to open anything to check.",
    "Here you choose whether the day is shown as a timeline or a list, which language the app speaks, and whether you want notifications on your phone.",
    "The app speaks Danish and English. The first time it follows your phone: if your phone is in Danish you get Danish, otherwise English. If you choose yourself, the choice follows you, also on a new phone.",
    "You can also request a link to change your password. It is sent to your email.",
    "Sign out is at the bottom on its own. You do not need to sign out at the end of the day — the app remembers you.",
  ] },
  { t: "List or timeline", p: [
    "The day is shown as a timeline with the clock running down the page. If you prefer a plain list, you can switch in your settings — tap your name at the top.",
    "The timeline shows the day like a calendar: how long each job takes and how much travel there is in between. A red line shows the current time.",
    "Once you have marked a job finished, the block turns green and gets a tick. If the block is tall enough, it also shows your logged time, the checklist, whether the key must be collected at the office, and who is invoiced — the same as on the list.",
    "Short jobs only have room for the time and the name. Open the job to see the rest.",
    "A solid border means the time is agreed with the customer. A dashed border with “ca.” means the time is calculated from when your day starts — if the day slips, so does it.",
    "Never promise a customer a “ca.” time. Call the office if the customer needs a fixed time.",
    "Your choice is remembered for next time. On a new phone it starts on timeline again.",
  ] },
  { t: "Notifications on your phone", p: [
    "The app can notify you when time entries are missing, when your schedule changes, and when the office has replied to a request for a new time.",
    "The first time, a banner appears at the top of the day with a button. Tap it and notifications are on, and the banner is gone.",
    "If you already said yes on another phone, the new one is registered automatically when you sign in.",
    "You can always turn them on or off in your settings — tap your name at the top.",
    "On iPhone the app must be on your home screen first. Tap Share in Safari, choose “Add to Home Screen”, and open Worklist from there. Without this iPhone cannot deliver notifications — that is Apple's rule, not ours.",
    "Notifications about schedule changes are grouped and arrive at most every 15 minutes, so several changes give you one message, not ten.",
    "In the evening you get a message about what is waiting tomorrow.",
    "You still get the same emails as before. You can turn notifications off again in the same place.",
  ], warn: "If you change phone, turn notifications on again on the new one. The old one stops by itself." },
  { t: "If there is a problem", p: [
    "At the bottom of the job you will find «There is a problem». Tap it and you get a screen with two options — nothing to scroll for.",
    "«Suggest a new time» is for when you have agreed a new time with the customer. The job stays with you until the office has moved it — sending the request does not remove it. If it is not possible, you get an email explaining why, and you need to call the customer again.",
    "«Could not get in» is for when nobody answered, the key did not fit, or the door was locked. Write what happened, and please take a photo of the door or the key box.",
    "With «could not get in» you can suggest a new date if you already know when you can come back. That is optional.",
    "Either way the office is notified straight away and decides whether the customer pays for the trip. That is not for you to judge.",
    "Do not log time on the job as if it had been done. Report it instead."] },
  { t: "Comments and photos", p: [
    "On every task you can write a comment to the office and take photos. You find it inside the task under «Comments and photos».",
    "Use it when something needs documenting: it was far dirtier than usual, something was broken, or the customer asked for extra work.",
    "There are two buttons. «Take photo» opens the camera and takes one photo at a time — just tap again for the next one, they add up.",
    "«From gallery» opens your phone's photos, where you can select several at once. This works on both iPhone and Android.",
    "You can have up to ten photos ready. The counter below the buttons shows how many. To drop one, tap the × in its corner.",
    "Write a line about what can be seen — a photo without text is hard for the office to use.",
    "If you send many photos, the button counts them as it goes — wait until it finishes and do not tap again.",
    "The photos are made smaller before they are sent, so it works on a poor mobile connection too.",
    "The office sees all of it when they prepare the invoice. Photos are deleted automatically after 12 months."] },
  { t: "Finding your jobs", p: [
      "When you open the app you see this week. Pick a day at the top.",
      "The small bubble shows how many jobs you have that day.",
      "The arrows change week. \"Today\" jumps back to today.",
      "\"+ Weekend\" shows Saturday and Sunday if you have shifts.",
      "Tap a job to open it." ] },
  { t: "Inside the job — while you work", p: [
      "The screen shows only what you need to do the work: the customer, the address, how to get in, and what has to be done.",
      "\"Show the way\" opens Google Maps.",
      "Under \"Access\" you tap to see the key box and code — see the section below.",
      "Under \"Tasks\" you tick off each thing as you finish it.",
      "Nothing needs to be registered here. That comes afterwards." ] },
  { t: "Key box codes and access", p: [
      "Codes are hidden until you tap \"Show access details\" yourself. It is not that we do not trust you — the codes belong to the customers' homes, and we have to be able to document who has seen them.",
      "When you open them, it is recorded with your name and the time. That is written on the button before you tap it.",
      "Open them as often as you need. There is no limit, and you do not need to ask permission.",
      "If the job in your day list says \"Pick up key or access card at the office\", go by the office first. Then there is no code — it is waiting for you." ] },
  { t: "When you are done — \"Complete job\"", p: [
      "\"Complete job\" sits at the bottom of the screen. It is always there, even if you have scrolled down a long list.",
      "You are then taken through a few questions, one at a time. The top shows how far you are — for example \"1 of 3\".",
      "At the end you get a receipt with what was registered, so you know it is saved and do not have to call the office to check.",
      "Forgot something? Open the job again and complete it again. The time is added to what you already registered — it is not overwritten.",
      "If two of you work the same job, you each complete it with your own time." ], warn:
      "Complete the job the same day. If you do not register your time, your mileage is not calculated — and you will not be paid for the drive. Every day at 18:00 you get an email if something is missing." },
  { t: "Step 1 — how long did it take?", p: [
      "The field is preset to the time planned for you. If that is right, just tap \"Next\" without changing anything.",
      "If there are several of you on the job, the time is per person. If 1 hour is planned and there are two of you, 2 hours are planned in total — you only enter your own time, and you are not told about an overrun because your colleague also registered.",
      "To change it, use the two rows of − and + : hours on top, minutes below. The buttons move in steps of 5 minutes.",
      "You can also tap the number itself and type whatever you need — including 18 minutes or any other value the buttons do not land on. The time has to match what you actually spent.",
      "The large number at the top is the total you are registering. Below it you can see whether it matches the plan.",
      "If it took longer than planned, you need to write why. It is not a telling-off — the office has to be able to explain it to the customer.",
      "If you undid a completion and open the job again — for example to add a photo — it says 0, and that is fine. Your time is already registered, and you do not need to enter more to continue." ] },
  { t: "Products for the customer", p: [
      "You pick up products at the office. The planner records what you were given, and for which customer. You do not select anything in the app yourself.",
      "If you are carrying items for a customer, an extra step appears when you complete a job for that customer. It shows what you were given, and you answer yes or no to whether the customer received it.",
      "It does not matter which job for that customer you are on — the handover follows you and the customer, not a particular day. If the job is moved, it comes along.",
      "If you say no, the items stay with you and show up again next time you visit that customer. The customer is only invoiced once you say yes.",
      "If you are not asked, you have nothing for that customer. Then there is one step fewer, and the counter at the top says for example \"1 of 2\"." ] },
  { t: "What you are missing", p: [
      "If you still need to log time or mark a job as completed, a yellow warning icon appears at the top with a number. The number is how many jobs are not finished.",
      "Tap it to see the whole list — including jobs from earlier weeks that you would otherwise have to page back to find. Oldest first, because those are closest to being lost.",
      "Tap a job in the list and it opens, so you can log the time and finish it right away. It then disappears from the list, and the number counts down.",
      "You always come back to the list afterwards — also if you change your mind and would rather take another one first. That way you can work your way down it without hunting for the warning icon every time.",
      "No warning icon means you are not missing anything. It is the same reckoning the 6 pm reminder email uses — the two cannot disagree.",
      "For the office: pick a colleague under \"Se plan for\" and the warning icon shows her count and her list, so you can help her over the phone. View only — you cannot register on her behalf.",
      "Remember: once the month closes, hours and mileage from that month can no longer go to payroll." ] },
  { t: "Nexus citizens", p: [
      "If the job is for a Nexus citizen, it says so at the top of the job, and there is a button to open KMD Nexus.",
      "When you complete the job there is an extra step reminding you to sign off in Nexus. The municipality pays according to Nexus — not according to what you write here.",
      "If you have signed off, tick the box. If you could not get into Nexus, leave it empty — you can still finish, and the office will follow up." ] },
  { t: "Order workwear", p: [
      "Tap the shirt icon at the top.",
      "Set the amount with + and − and tap \"Select products\".",
      "Your order goes to the office for approval. \"History\" shows earlier orders." ] },
  { t: "When there is no coverage", p: [
      "The app saves this week's jobs on your phone, so you can see today's list even in a basement or a holiday-home area with no signal.",
      "With no connection you get a yellow bar at the top: \"Saved copy — no connection\", and when it was fetched. So you know that any change the office made since then is not included.",
      "The bar disappears by itself once you have coverage again, and the list is fetched afresh.",
      "You can complete a job without coverage. Time, checkmarks, comments and photos go into a queue and are sent automatically once you have a connection again.",
      "If something is waiting, a yellow bar appears at the top: \"2 entries are waiting for coverage\". It disappears when everything has been sent.",
      "Important: do not close the app completely while something is in the queue. It can only send while the app is open. If in doubt, open the app again once you have coverage — it sends by itself.",
      "If you sign out while something is queued, it is lost. The app asks first.",
      "Access details are fetched with the blue button at the top while you have coverage — ideally before you leave home. They are kept until tonight and then deleted. If you are at a locked door with no signal and have not fetched them, call the office.",
      "For this to work the app must be on your home screen. On iPhone: tap the share icon at the bottom and choose \"Add to Home Screen\". Without that, the phone clears the saved copy after a week." ] },
  { t: "Customer meetings and quotes", p: [
      "This section is for planners only. If you are not a planner, you see neither the button nor the meetings.",
      "Tap the calendar icon at the top to book a customer meeting. The customer does not have to exist in Dinero yet.",
      "The meeting goes into your week, so the office can see you are out, and the time counts in your capacity.",
      "Open the meeting once you are there. You get the quote screen instead of the ordinary job: notes, photos, price and which services are included.",
      "The notes field is made for dictation. Tap the microphone on the keyboard and speak — edit it afterwards.",
      "You can add up to 10 photos. They are internal unless you choose to show them to the customer on the quote.",
      "\"Send to customer\" creates the PDF and mails a link she can accept from. If she accepts, the agreement is created as a draft — you set the start date and weekdays yourself." ] },
  { t: "Your hours — the three figures", p: [
      "Tap the car icon at the top. The Hours tab shows what is reported to payroll.",
      "There are three figures, and they are not the same thing. \"Planned\" is the time the office set aside for the job. \"Logged\" is the time you registered yourself. \"To payroll\" is what the office has approved.",
      "Only approved hours go into the payroll file. That is why \"To payroll\" can be lower than \"Logged\" — your hours are not lost, the office simply has not reviewed them yet.",
      "If a job says \"No time logged\", you still need to register it. Do it before the month closes — without logged time the job is not paid.",
      "\"Of which weekend\" is the hours that trigger the weekend supplement, if you are on that arrangement.",
      "Use the arrows at the top to go back in time. You can see this month and eleven months back.",
      "If a figure does not match what you remember, contact the office with the date and the job. Then you are both looking at the same thing.",
      "If several of you are on a job, the office may have split the hours unevenly. The time suggested when you finish is YOUR share — not the whole job.",
      "If you are on a job to learn, it says so on the job. Log your time as usual — it counts towards your pay just like anything else. It is only the customer's invoice it does not go on.",
      "If you are a planner and have selected a colleague under \"Se plan for\", the page shows her figures, not yours. Her name is in the heading and an orange bar appears at the top.",
    ] },
  { t: "Your mileage", p: [
      "The Driving tab — same place as your hours — shows your calculated mileage.",
      "It also shows whether each trip is approved for payment, and how many kilometres are approved in total.",
      "The rate per kilometre is set in the payroll system and is not shown in the app. It changes by law every year.",
      "If the office has added an activity with driving — collecting materials, for instance — the trip appears here as its own lines. If it is a return trip, each direction is listed separately.",
      "If travel is part of your working hours, the day starts with \"Travel from home\" and ends with \"Travel home\". The time at the top is when you leave home, not when you must be at the first customer.",
      "If you do not see those two lines, you are not on that arrangement, and your driving is paid as mileage instead. Ask the office if you are unsure what applies to you.",
      "You do not enter kilometres yourself — it is calculated from your jobs once you register your time." ] },
  { t: "If something goes wrong", p: [
      "Cannot log in? Check your email and use \"Forgot password?\".",
      "Cannot see your jobs? Check you are on the right week and day.",
      "A job is missing? Contact the office — they can move it.",
      "App stuck? Close the page and open it again." ] },
  { t: "Your personal data", p: [
      "Jammerbugt Rengøring is responsible for the information the app stores about you. This is exactly what it is.",
      "About you: your name, your work email, your language choice, your usual start time, your skills and the areas you cover.",
      "Your home address, if you are on an arrangement where travel from home counts as working time. It is used only to calculate the distance to the first job of the day — nothing else.",
      "About your work: which jobs you are assigned, when you logged time, how long, and the messages you send to the office.",
      "About your pay: your hourly rate and previous rates, bonus and mileage rate, whether you have the weekend supplement and holiday pay, and your employee number in Danløn.",
      "Absence is recorded as absence. It never says why you were away.",
      "If you turn notifications on, a technical address for your phone is stored so the message can reach you.",
    ] },
  { t: "What the app does not store", p: [
      "The app does not track you. There is no GPS and no location tracking — neither during working hours nor outside them. Mileage is calculated from the addresses of your jobs, not from where your phone has been.",
      "There is no civil registration number anywhere in the system. The payroll file uses your Danløn number.",
      "There are no bank details and no account number.",
      "There is no health information, no diagnoses and no reasons for sickness.",
    ] },
  { t: "Who can see what", p: [
      "The office can see your jobs, your logged time and your pay. They need to, in order to plan and to pay you.",
      "Your colleagues cannot see your pay, your notes or your access codes. It is not merely hidden on screen — the database refuses it.",
      "Outside the company: the database is hosted by Supabase in Stockholm. Email is sent through Brevo in France. Distances are calculated by a German routing service and by the Danish state address register, which receive the address but not your name.",
      "Notifications travel through Apple and Google. The content is encrypted on the way — they cannot read what it says.",
      "The payroll file is not sent anywhere automatically. The office downloads it as a file and uploads it to Danløn themselves.",
    ] },
  { t: "How long, and your rights", p: [
      "If you leave, your login and work email are deleted immediately, and you are signed out on every phone.",
      "Your name and the documentation of pay and mileage remain. It has to be available years later — including if you need it yourself.",
      "Photos on jobs are deleted automatically after 12 months. Access codes to customers' homes are deleted three months after the job is completed.",
      "You have the right to see what we hold about you, and to have anything incorrect corrected. Ask the office.",
      "Notifications on your phone are yours to turn on and off under your settings.",
    ] },
];

// Udskriver vejledningen som den staar i appen. Hjaelpeteksten er kilden — der
// findes ingen separat PDF der skal huskes opdateret.
function udskrivVejledning(sections, da) {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const idag = new Date().toLocaleDateString(da ? "da-DK" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  const titel = da ? "Sådan bruger du appen" : "How to use the app";
  const krop = (sections || []).map((s) => `<h2>${esc(s.t)}</h2>` + (s.p || []).map((l) => `<p>${esc(l)}</p>`).join("")).join("");
  const w = window.open("", "_blank");
  if (!w) { alert(da ? "Tillad pop op-vinduer for at kunne udskrive." : "Allow pop-ups to print."); return; }
  w.document.write(
    `<!doctype html><html lang="${da ? "da" : "en"}"><head><meta charset="utf-8"><title>${esc(titel)}</title><style>` +
    `body{font-family:Inter,-apple-system,system-ui,sans-serif;color:#111;line-height:1.55;max-width:700px;margin:0 auto;padding:26px 24px}` +
    `h1{color:#D6247A;font-size:24px;margin:0 0 4px}.dato{color:#94A3B8;font-size:12px;margin:0 0 24px}` +
    `h2{font-size:16px;margin:22px 0 6px;page-break-after:avoid}p{font-size:13.5px;margin:4px 0}@page{margin:16mm}` +
    `</style></head><body><h1>Worklist</h1><p class="dato">${esc(titel)} · ${da ? "udskrevet" : "printed"} ${esc(idag)}</p>${krop}</body></html>`
  );
  w.document.close(); w.focus(); setTimeout(() => w.print(), 400);
}
function HelpPage({ lang, onClose, onVisIgen }) {
  const da = lang === "da";
  const sections = da ? HELP_DA : HELP_EN;
  return (
    <div style={{ position:"fixed", inset:0, background:"#FDFCF8", zIndex:120, display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"calc(14px + env(safe-area-inset-top)) 16px 14px",
                    borderBottom:"1px solid #E2E8F0", background:"#111", color:"#fff" }}>
        <div>
          <div style={{ fontWeight:800, fontSize:16 }}>{da ? "Sådan bruger du appen" : "How to use the app"}</div>
          <button onClick={() => udskrivVejledning(sections, da)}
            style={{ marginTop:6, border:"1px solid #555", background:"transparent", color:"#fff", borderRadius:8, padding:"4px 10px", fontSize:11.5, cursor:"pointer" }}>
            {da ? "Udskriv vejledningen" : "Print the guide"}
          </button>
        </div>
        <button onClick={onClose}
          style={{ border:"none", background:"#333", color:"#fff", borderRadius:8, width:36, height:36, fontSize:18, cursor:"pointer" }}>✕</button>
      </div>
      <div style={{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch",
                    padding:"14px 16px calc(32px + env(safe-area-inset-bottom))",
                    textAlign:"left", maxWidth:640, margin:"0 auto", width:"100%", boxSizing:"border-box" }}>
        <div style={{ background:"#FCE4EF", borderRadius:10, padding:"12px 14px", marginBottom:16,
                      fontSize:14.5, lineHeight:1.5, color:"#9C1B5D", fontWeight:700 }}>
          {da ? "Hver dag: åbn appen → tryk på opgaven → sæt flueben → registrér tid → marker som udført."
              : "Every day: open the app → tap the job → tick off tasks → register time → mark as done."}
        </div>
        {/* Vejen tilbage til introduktionen.
            Den vises kun én gang af sig selv, og den, der har trykket «Spring
            over» på sin første dag, skal kunne finde den igen uden at skulle
            ringe til kontoret. Øvelsen står lige under: der kan man prøve en hel
            dag igennem uden at røre en rigtig kunde. */}
        <div style={{ display:"flex", gap:9, flexWrap:"wrap", marginBottom:18 }}>
          {onVisIgen && (
            <button onClick={onVisIgen}
              style={{ flex:"1 1 46%", border:"1.5px solid #E2E8F0", background:"#FDFCF8",
                       borderRadius:11, padding:"13px 12px", fontSize:15, fontWeight:600,
                       color:"#334155", cursor:"pointer", fontFamily:"inherit", minHeight:50 }}>
              {da ? "Vis introduktionen igen" : "Show the intro again"}
            </button>
          )}
          {/* Samme fane, ikke en ny.
              Med target="_blank" endte hun med to faner: øvelsen foran og
              Worklist bagved. Knappen «Tilbage til Worklist» inde i øvelsen går
              til forsiden, og så ville hun stå med appen i BEGGE faner uden at
              vide hvorfor. I samme fane er der kun én app og én vej tilbage. */}
          <a href="/proev.html"
            style={{ flex:"1 1 46%", border:"1.5px solid #E2E8F0", background:"#FDFCF8",
                     borderRadius:11, padding:"13px 12px", fontSize:15, fontWeight:600,
                     color:"#334155", textDecoration:"none", minHeight:50,
                     display:"flex", alignItems:"center", justifyContent:"center" }}>
            {da ? "Øv dig på en prøvedag" : "Practise on a test day"}
          </a>
        </div>

        {sections.map((sec, i) => (
          <div key={i} style={{ marginBottom:20 }}>
            <div style={{ fontWeight:800, fontSize:16, color:"#111", marginBottom:7 }}>{sec.t}</div>
            {sec.p.map((line, j) => (
              <div key={j} style={{ fontSize:15, lineHeight:1.55, color:"#334155", marginBottom:6 }}>{line}</div>
            ))}
            {sec.warn && (
              <div style={{ marginTop:9, background:"#FEF3C7", borderLeft:"4px solid #D97706",
                            borderRadius:6, padding:"11px 13px", fontSize:14.5, lineHeight:1.5, color:"#111", fontWeight:600 }}>
                {sec.warn}
              </div>
            )}
          </div>
        ))}
        <div style={{ fontSize:13, color:"#94A3B8", borderTop:"1px solid #E2E8F0", paddingTop:12 }}>
          {da ? "Spørgsmål? Kontakt kontoret." : "Questions? Contact the office."}
        </div>
      </div>
    </div>
  );
}

// ── Første gang ──────────────────────────────────────────────────────────────
//
// Tre skærmbilleder, første gang appen åbnes, og aldrig igen.
//
// Hvorfor ikke en rundvisning i det hele: fordi den bliver sprunget over. Der er
// fireogtyve afsnit i hjælpen, og ingen læser dem, mens de står med en telefon,
// de ikke er trygge ved. De tre her er skåret ned til det, der skal til for at
// komme igennem den første dag — resten kan slås op, når der bliver brug for det.
//
// Den vigtigste af de tre er den første. Den handler ikke om appen, men om at
// man ikke kan ødelægge noget. Det er den frygt, der gør, at det første tryk
// ellers aldrig bliver til noget.
const VELKOMST = {
  da: [
    { ikon: "✋", t: "Du kan ikke ødelægge noget",
      p: ["Tryk roligt på det, du er i tvivl om. Der er altid en vej tilbage, og intet bliver sendt til kontoret, før du selv melder en opgave færdig.",
          "Er der noget, du ikke kan finde ud af, så ring til kontoret. Det er ikke dumt at spørge."] },
    { ikon: "📋", t: "Her er din dag",
      p: ["Dine opgaver står i den rækkefølge, du skal tage dem. Adressen står på hver enkelt, så du kan se, hvor du skal hen uden at åbne noget.",
          "Tryk på en opgave for at åbne den. Så kan du se, hvad der skal laves, og hvordan du kommer ind."] },
    { ikon: "✓", t: "Sådan melder du færdig",
      p: ["Sæt flueben ved det, du har lavet. Tryk så «Afslut opgave» nederst.",
          "Du bliver spurgt, hvor lang tid du brugte. Tiden står på forhånd — passer den, trykker du bare videre.",
          "Mangler der et flueben, må du godt melde færdig alligevel. Så følger kontoret op."] },
  ],
  en: [
    { ikon: "✋", t: "You cannot break anything",
      p: ["Tap anything you are unsure about. There is always a way back, and nothing is sent to the office until you finish a job yourself.",
          "If something is unclear, call the office. Asking is not silly."] },
    { ikon: "📋", t: "This is your day",
      p: ["Your jobs are listed in the order you should take them. The address is on each one, so you can see where to go without opening anything.",
          "Tap a job to open it. Then you can see what needs doing and how to get in."] },
    { ikon: "✓", t: "How to finish a job",
      p: ["Tick off what you have done. Then tap «Finish job» at the bottom.",
          "You will be asked how long you spent. The time is filled in already — if it is right, just continue.",
          "If a tick is missing you may still finish. The office will follow up."] },
  ],
};

// Nøglen ligger i browseren og ikke i databasen. Med vilje: den hører til DEN
// telefon, ikke til medarbejderen. Får hun en ny telefon, er det en ny første
// gang — og det er netop dér, hun har brug for den igen.
const VELKOMST_NOEGLE = "wl_velkomst_set";

// Ikke eksporteret. Den bruges kun herinde, og et export ved siden af
// komponenterne giver en advarsel om, at filen så indeholder to slags ting.
//
// Kan localStorage ikke læses — privat browsing, eller en telefon hvor det er
// slået fra — svares der «set». Hellere springe introduktionen over end vise den
// ved HVER åbning, fordi svaret alligevel ikke kan gemmes.
function velkomstErSet() {
  try { return localStorage.getItem(VELKOMST_NOEGLE) === "1"; } catch { return true; }
}
function husVelkomstSet() {
  try { localStorage.setItem(VELKOMST_NOEGLE, "1"); } catch { /* privat browsing */ }
}

function Velkomst({ lang, navn, onLuk }) {
  const da = lang === "da";
  const trin = VELKOMST[da ? "da" : "en"];
  const [nr, setNr] = useState(0);
  const sidste = nr === trin.length - 1;
  const t = trin[nr];

  function luk() { husVelkomstSet(); onLuk(); }

  return (
    <div style={{ position:"fixed", inset:0, background:"#FDFCF8", zIndex:200,
                  display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", justifyContent:"flex-end",
                    padding:"calc(12px + env(safe-area-inset-top)) 14px 0" }}>
        {/* «Spring over» står på hver skærm. En introduktion, man ikke kan komme
            ud af, er en fælde — og den, der har set den før, skal ikke tvinges
            igennem den igen for at komme til sin dag. */}
        <button onClick={luk}
          style={{ border:"none", background:"transparent", color:"#64748B",
                   fontSize:15, fontFamily:"inherit", cursor:"pointer", padding:"10px 8px" }}>
          {da ? "Spring over" : "Skip"}
        </button>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"8px 26px 20px",
                    display:"flex", flexDirection:"column", justifyContent:"center",
                    maxWidth:520, margin:"0 auto", width:"100%", boxSizing:"border-box" }}>
        <div style={{ fontSize:58, marginBottom:18 }}>{t.ikon}</div>
        <div style={{ fontSize:25, fontWeight:800, marginBottom:14, lineHeight:1.25 }}>
          {nr === 0 && navn ? (da ? `Hej ${navn}. ` : `Hi ${navn}. `) : ""}{t.t}
        </div>
        {t.p.map((linje, i) => (
          <div key={i} style={{ fontSize:17, lineHeight:1.6, color:"#334155", marginBottom:12 }}>
            {linje}
          </div>
        ))}
      </div>

      <div style={{ padding:"14px 20px calc(22px + env(safe-area-inset-bottom))",
                    borderTop:"1px solid #F1F5F9" }}>
        {/* Prikkerne viser, hvor langt man er. Tre skridt er til at overskue —
            uden dem ved man ikke, om der kommer tyve mere. */}
        <div style={{ display:"flex", justifyContent:"center", gap:8, marginBottom:16 }}>
          {trin.map((_, i) => (
            <div key={i} style={{ width: i === nr ? 22 : 8, height:8, borderRadius:4,
                                  background: i === nr ? "#D6247A" : "#E2E8F0" }} />
          ))}
        </div>
        <button
          onClick={() => (sidste ? luk() : setNr(nr + 1))}
          style={{ width:"100%", padding:"17px 0", borderRadius:14, border:"none",
                   background:"#D6247A", color:"#fff", fontWeight:700, fontSize:17,
                   cursor:"pointer", fontFamily:"inherit", minHeight:56 }}>
          {sidste ? (da ? "Så er jeg klar" : "I am ready") : (da ? "Videre" : "Next")}
        </button>
      </div>
    </div>
  );
}

function LangToggle({ lang, setLang }) {
  return (
    <div style={s.langRow}>
      <button style={{ ...s.flagBtn, opacity: lang === "da" ? 1 : 0.45 }} onClick={() => setLang("da")}>🇩🇰</button>
      <button style={{ ...s.flagBtn, opacity: lang === "en" ? 1 : 0.45 }} onClick={() => setLang("en")}>🇬🇧</button>
    </div>
  );
}

// ── Login ─────────────────────────────────────────────────────────────────────
function LoginScreen({ lang, setLang, initialError }) {
  const t = T[lang];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
    useEffect(() => { if (initialError) setError(initialError); }, [initialError]);

  async function requestPasswordReset() {
    if (!email.trim()) { setError(t.forgotPasswordEmailRequired); return; }
    setLoading(true); setError(""); setResetSent(false);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin + "/",
    });
    setLoading(false);
    if (err) setError(t.resetError);
    else setResetSent(true);
  }

  async function signIn() {
    if (!email.trim() || !password) return;
    setLoading(true); setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (err) setError(t.loginError);
  }

  return (
    <div style={s.loginWrap}>
      <LangToggle lang={lang} setLang={setLang} />
      <div style={s.loginCard}>
        <div style={s.brand}>
          <img src="/app-icon.png" alt="Worklist" style={s.brandIcon} />
          <div>
            <div style={s.brandTitle}>{t.appName}</div>
            <div style={s.brandSub}>{t.appSub}</div>
          </div>
        </div>
        <div style={s.loginLabel}>{t.emailLabel}</div>
        <input type="email" style={s.loginInput} value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") signIn(); }}
          placeholder={t.emailPlaceholder} autoFocus />
        <div style={s.loginLabel}>{t.passwordLabel}</div>
        <input type="password" style={s.loginInput} value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") signIn(); }}
          placeholder="••••••••" />
        {error && <div style={s.errorBox}>{error}</div>}
        <button style={{ ...s.loginBtn, opacity: (!email.trim() || !password || loading) ? 0.5 : 1 }}
          disabled={loading || !email.trim() || !password} onClick={signIn}>
          {loading ? t.loggingIn : t.loginBtn}
        </button>
          <button
            type="button"
            onClick={requestPasswordReset}
            disabled={loading || !email.trim()}
            style={{ width:"100%",padding:"10px 0",marginTop:10,border:"none",background:"transparent",color:"#D6247A",fontWeight:600,fontSize:13,cursor:"pointer",textAlign:"center" }}>
            {t.forgotPassword}
          </button>
          {resetSent && <div style={{ fontSize:13,color:"#16A34A",marginTop:8,padding:"10px 12px",background:"#ECFDF5",borderRadius:10 }}>{t.resetSentMsg(email.trim())}</div>}
      </div>
    </div>
  );
}

// ── Set new password (after clicking reset link) ─────────────────────────────
function SetNewPasswordScreen({ lang, setLang, onDone }) {
  const t = T[lang];
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function save() {
    if (pw1.length < 6) { setError(t.passwordTooShort); return; }
    if (pw1 !== pw2) { setError(t.passwordMismatch); return; }
    setLoading(true); setError("");
    const { error: err } = await supabase.auth.updateUser({ password: pw1 });
    setLoading(false);
    if (err) setError(t.passwordUpdateError);
    else setDone(true);
  }

  return (
    <div style={s.loginWrap}>
      <LangToggle lang={lang} setLang={setLang} />
      <div style={s.loginCard}>
        <div style={s.brand}>
          <img src="/app-icon.png" alt="Worklist" style={s.brandIcon} />
          <div>
            <div style={s.brandTitle}>{t.appName}</div>
            <div style={s.brandSub}>{t.newPasswordTitle}</div>
          </div>
        </div>
        {done ? (
          <>
            <div style={{ fontSize:13,color:"#16A34A",marginBottom:16,padding:"10px 12px",background:"#ECFDF5",borderRadius:10 }}>{t.passwordUpdated}</div>
            <button style={s.loginBtn} onClick={onDone}>{t.continueBtn}</button>
          </>
        ) : (
          <>
            <div style={s.loginLabel}>{t.newPasswordLabel}</div>
            <input type="password" style={s.loginInput} value={pw1}
              onChange={(e) => setPw1(e.target.value)}
              placeholder="••••••••" autoFocus />
            <div style={s.loginLabel}>{t.repeatPasswordLabel}</div>
            <input type="password" style={s.loginInput} value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              placeholder="••••••••" />
            {error && <div style={s.errorBox}>{error}</div>}
            <button style={{ ...s.loginBtn, opacity: (!pw1 || !pw2 || loading) ? 0.5 : 1 }}
              disabled={loading || !pw1 || !pw2} onClick={save}>
              {loading ? t.savingPassword : t.saveNewPassword}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ProductPage er fjernet. Produkter udleveres nu paa kontoret af planlaeggeren, og
// medarbejderen BEKRAEFTER blot i afslutningsflowet at kunden har faaet dem. Hun
// vaelger altsaa ikke laengere varer i appen - hun koerer i privat bil og har
// aldrig lagervarer med.

// ── Adressefelt med opslag i Danmarks adresseregister ────────────────────────
// Rengoeringsdamerne kan ikke rette en adresse nogen steder — men planlaeggeren kan,
// fra telefonen, naar hun booker et moede eller udfylder et tilbud. Og tilbuddets
// adresse bliver til aftalens adresse ved accept, og derfra til alle kommende opgaver
// og koeretider. Samme fejl som i planlaegningsappen, bare ad den anden vej — og ad
// den vej har hun travlt, fordi hun staar hos kunden.
//
// Registret er dataforsyningen.dk, samme kilde som geokodningen i travel-distance.
// Fri indtastning er stadig tilladt: flere adresser i drift har etage og doer skrevet
// ind, og en spaerring ville bare faa hende til at lade feltet staa tomt.
function AdresseFelt({ vaerdi, onChange, disabled, placeholder, felt }) {
  const [forslag, setForslag] = useState([]);
  const [kendt, setKendt] = useState(null);   // null = ikke slaaet op endnu
  const [valgt, setValgt] = useState(false);
  const ur = useRef(null);

  const ens = (a, b) => (a || "").toLowerCase().replace(/[\s,.]/g, "")
                     === (b || "").toLowerCase().replace(/[\s,.]/g, "");

  useEffect(() => {
    if (disabled) return;
    const q = (vaerdi || "").trim();
    setValgt(false);
    if (q.length < 3) { setForslag([]); setKendt(null); return; }
    clearTimeout(ur.current);
    // Ventetid foer opslaget. Uden den kaldes registret ved hvert tastetryk — og hun
    // sidder formentlig paa mobildata.
    ur.current = setTimeout(async () => {
      try {
        const res = await fetch(
          "https://api.dataforsyningen.dk/adresser/autocomplete?per_side=5&q=" + encodeURIComponent(q));
        const data = res.ok ? await res.json() : [];
        const liste = Array.isArray(data) ? data : [];
        setForslag(liste);
        setKendt(liste.some((f) => ens(f.tekst, q)));
      } catch {
        // Ingen daekning eller registret nede. Saa siger vi ingenting frem for at
        // paastaa at adressen er forkert.
        setForslag([]); setKendt(null);
      }
    }, 400);
    return () => clearTimeout(ur.current);
  }, [vaerdi, disabled]);

  return (
    <>
      <input style={felt} value={vaerdi || ""} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />

      {!disabled && !valgt && forslag.length > 0 && !kendt && (
        <div style={{ border: "1.5px solid #E2E8F0", borderRadius: 10, marginTop: 6, overflow: "hidden" }}>
          {forslag.map((f) => (
            <div key={f.adresse?.id || f.tekst}
              onClick={() => { onChange(f.tekst); setForslag([]); setValgt(true); setKendt(true); }}
              style={{ padding: "12px 12px", fontSize: 14, borderBottom: "1px solid #F1F5F9" }}>
              {f.tekst}
            </div>
          ))}
        </div>
      )}

      {kendt === false && (vaerdi || "").trim().length >= 3 && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 9,
                      padding: "9px 11px", marginTop: 6, fontSize: 12.5, color: "#92400E", lineHeight: 1.5 }}>
          Adressen findes ikke i adresseregistret. Kørsel kan ikke beregnes. Vælg et
          forslag, eller tjek stavemåden.
        </div>
      )}
      {kendt === true && (
        <div style={{ fontSize: 12, color: "#166534", marginTop: 5 }}>✓ Fundet i adresseregistret</div>
      )}
    </>
  );
}

// ── Læg appen på hjemmeskærmen ───────────────────────────────────────────────
// iOS rydder lokale data for websteder der ikke er brugt i syv dage. Installerede
// web-apps er undtaget. Uden installation forsvinder baade den gemte dagsliste og
// skrivekoeen for en medarbejder der har haft fri en uge — og saa virker offline slet
// ikke, uden at nogen forstaar hvorfor.
//
// Derfor er det en bjaelke i appen og ikke en linje i hjaelpen. Hjaelpen laeser de
// faerreste; en bjaelke over dagslisten er svaer at komme udenom.
function erInstalleret() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || window.navigator?.standalone === true;
}

function InstallerBjaelke({ lang }) {
  const da = lang === "da";
  const [skjult, setSkjult] = useState(() => {
    try {
      const til = Number(localStorage.getItem("wl_installer_skjult") || 0);
      return til > Date.now();
    } catch { return false; }
  });

  if (erInstalleret() || skjult) return null;

  // iOS har ingen installationsknap — brugeren SKAL gennem delemenuen. Android
  // spoerger som regel selv, men ikke altid, saa begge vejledninger staar der.
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function skjulEnUge() {
    // Ikke for evigt. Uden appen paa hjemmeskaermen virker offline ikke, saa
    // paamindelsen skal komme igen.
    try { localStorage.setItem("wl_installer_skjult", String(Date.now() + 7 * 864e5)); } catch { /* fuldt lager */ }
    setSkjult(true);
  }

  return (
    <div style={{ background: "#EEF2FF", borderBottom: "1px solid #C7D2FE", padding: "11px 16px" }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#3730A3" }}>
        {da ? "Læg appen på hjemmeskærmen" : "Add the app to your home screen"}
      </div>
      <div style={{ fontSize: 12.5, color: "#4338CA", marginTop: 3, lineHeight: 1.5 }}>
        {da
          ? "Ellers kan du ikke se dine opgaver uden dækning — telefonen sletter det gemte efter en uge."
          : "Otherwise you cannot see your jobs without coverage — the phone deletes the saved copy after a week."}
      </div>
      <div style={{ fontSize: 12.5, color: "#4338CA", marginTop: 8, lineHeight: 1.6 }}>
        {iOS
          ? (da
              ? "Tryk på del-ikonet nederst på skærmen (firkanten med pilen op), rul ned og vælg «Føj til hjemmeskærm». Tryk så «Tilføj»."
              : "Tap the share icon at the bottom (the square with an arrow), scroll down and choose \"Add to Home Screen\". Then tap \"Add\".")
          : (da
              ? "Tryk på de tre prikker øverst til højre og vælg «Installer app» eller «Føj til startskærm»."
              : "Tap the three dots at the top right and choose \"Install app\" or \"Add to Home screen\".")}
      </div>
      <button onClick={skjulEnUge}
        style={{ marginTop: 10, border: "none", background: "#C7D2FE", color: "#3730A3",
                 borderRadius: 8, padding: "7px 12px", fontSize: 12.5, fontWeight: 700,
                 cursor: "pointer", fontFamily: "inherit" }}>
        {da ? "Ikke nu" : "Not now"}
      </button>
    </div>
  );
}

// ── Tilbud ude hos kunden ────────────────────────────────────────────────────
// Moedeopgaven er af typen 'aktivitet' og haenger sammen med en raekke i tilbud.
// Hun sidder hos kunden med telefonen, saa det er HER tilbuddet bliver til — ikke
// i planlaegningsappen bagefter, hvor halvdelen af det hun saa er glemt.
const TILBUD_MAKS_FOTOS = 10;

function TilbudSkaerm({ task, employee, supabaseClient, onSetStatus, onLuk }) {
  const synlig = useSynligHoejde();
  const [tilbud, setTilbud] = useState(null);
  const [henter, setHenter] = useState(true);
  const [lister, setLister] = useState([]);
  const [priser, setPriser] = useState({});
  const [gemmer, setGemmer] = useState(false);
  const [fejl, setFejl] = useState("");
  const [besked, setBesked] = useState("");
  const [fotoUrls, setFotoUrls] = useState({});
  const [fotoArbejde, setFotoArbejde] = useState(null);
  // Er moedet hakket af? Laeses af opgaven, ikke af tilbuddet — det er opgaven der
  // staar i ugeplanen og som kontoret kigger paa.
  const [moedeHoldt, setMoedeHoldt] = useState(
    () => !!((task.completed_by_employee || {})[employee.id]),
  );

  // Ét felt pr. ting hun kan rette. Holdes samlet i ét objekt, saa gemningen bliver
  // ét kald i stedet for tolv.
  const [f, setF] = useState({});
  const saet = (n, v) => setF((p) => ({ ...p, [n]: v }));

  useEffect(() => {
    let afbrudt = false;
    (async () => {
      const [{ data: t }, { data: cl }, { data: cli }, { data: pr }] = await Promise.all([
        supabaseClient.from("tilbud").select("*").eq("instance_id", task.id).maybeSingle(),
        supabaseClient.from("checklist_templates").select("id, name").order("name"),
        supabaseClient.from("checklist_template_items").select("checklist_template_id"),
        supabaseClient.from("pricing").select("contract_type, hourly_rate"),
      ]);
      if (afbrudt) return;
      setLister((cl || []).map((c) => ({
        ...c, antal: (cli || []).filter((i) => i.checklist_template_id === c.id).length,
      })));
      const satser = Object.fromEntries((pr || []).map((p) => [p.contract_type, Number(p.hourly_rate)]));
      setPriser(satser);
      setTilbud(t || null);
      if (t) {
        // Vi VED hvad prisen er, saa snart kontrakttypen er kendt. Stod feltet tomt,
        // skulle hun huske satsen udenad mens kunden sad og kiggede.
        const startTimepris = t.timepris ?? (t.pricing_type !== "fixed"
          ? (satser[t.contract_type || "privat"] ?? "")
          : "");
        setF({
          kunde_navn: t.kunde_navn || "", adresse: t.adresse || "",
          kontaktperson: t.kontaktperson || "", kunde_email: t.kunde_email || "",
          titel: t.titel || "", contract_type: t.contract_type || "privat",
          pricing_type: t.pricing_type || "hourly",
          timepris: startTimepris, fast_pris: t.fast_pris ?? "",
          anslaaet_timer: t.anslaaet_timer ?? "", plan_interval: t.plan_interval || "uge",
          checklist_template_ids: t.checklist_template_ids || [],
          referat: t.referat || "", bemaerkning: t.bemaerkning || "",
          fotos: t.fotos || [], fotos_i_pdf: t.fotos_i_pdf ?? false,
        });
      }
      setHenter(false);
    })();
    return () => { afbrudt = true; };
  }, [task.id, supabaseClient]);

  // Bucket'en er privat. URL'erne signeres og udloeber af sig selv.
  useEffect(() => {
    let afbrudt = false;
    const stier = f.fotos || [];
    (async () => {
      if (stier.length === 0) { setFotoUrls({}); return; }
      const { data } = await supabaseClient.storage.from("tilbud").createSignedUrls(stier, 3600);
      if (afbrudt || !data) return;
      const kort = {};
      stier.forEach((s, i) => { if (data[i]?.signedUrl) kort[s] = data[i].signedUrl; });
      setFotoUrls(kort);
    })();
    return () => { afbrudt = true; };
  }, [(f.fotos || []).join("|")]);

  async function gem(ekstra = {}) {
    setFejl("");
    const raekke = {
      kunde_navn: (f.kunde_navn || "").trim() || task.customerName || "Kunde",
      adresse: (f.adresse || "").trim() || null,
      kontaktperson: (f.kontaktperson || "").trim() || null,
      kunde_email: (f.kunde_email || "").trim() || null,
      titel: (f.titel || "").trim() || null,
      contract_type: f.contract_type, pricing_type: f.pricing_type,
      timepris: f.pricing_type === "hourly" ? (Number(f.timepris) || null) : null,
      fast_pris: f.pricing_type === "fixed" ? (Number(f.fast_pris) || null) : null,
      anslaaet_timer: Number(f.anslaaet_timer) || null,
      plan_interval: f.plan_interval,
      checklist_template_ids: f.checklist_template_ids || [],
      referat: (f.referat || "").trim() || null,
      bemaerkning: (f.bemaerkning || "").trim() || null,
      fotos: f.fotos || [], fotos_i_pdf: !!f.fotos_i_pdf,
      ...ekstra,
    };
    const { error } = await supabaseClient.from("tilbud").update(raekke).eq("id", tilbud.id);
    if (error) { setFejl(error.message); return false; }
    return true;
  }

  async function gemOgLuk() {
    setGemmer(true);
    const ok = await gem();
    setGemmer(false);
    if (ok) onLuk();
  }

  // Lukker uden at gemme. Har hun rettet noget, spoerges der foerst — et referat der
  // er dikteret hos kunden maa ikke ryge fordi hun ramte tilbage-knappen.
  function luk() {
    if (!laast && aendret()) {
      if (!window.confirm("Du har ændringer der ikke er gemt. Vil du forlade tilbuddet alligevel?")) return;
    }
    onLuk();
  }

  // Sammenligner det hun ser med det der staar i databasen. Fotos taeller ikke med:
  // de er allerede sendt af sted i det oejeblik de blev valgt.
  function aendret() {
    if (!tilbud) return false;
    const somGemt = {
      kunde_navn: tilbud.kunde_navn || "", adresse: tilbud.adresse || "",
      kontaktperson: tilbud.kontaktperson || "", kunde_email: tilbud.kunde_email || "",
      titel: tilbud.titel || "", contract_type: tilbud.contract_type || "privat",
      pricing_type: tilbud.pricing_type || "hourly",
      referat: tilbud.referat || "", bemaerkning: tilbud.bemaerkning || "",
      plan_interval: tilbud.plan_interval || "uge",
    };
    for (const n of Object.keys(somGemt)) {
      if (String(f[n] ?? "") !== String(somGemt[n])) return true;
    }
    if (String(f.timepris ?? "") !== String(tilbud.timepris ?? "")) return true;
    if (String(f.fast_pris ?? "") !== String(tilbud.fast_pris ?? "")) return true;
    if (String(f.anslaaet_timer ?? "") !== String(tilbud.anslaaet_timer ?? "")) return true;
    if ((f.checklist_template_ids || []).join("|")
        !== (tilbud.checklist_template_ids || []).join("|")) return true;
    if (!!f.fotos_i_pdf !== !!tilbud.fotos_i_pdf) return true;
    return false;
  }

  async function tilfoejFotos(filer) {
    setFejl("");
    const plads = TILBUD_MAKS_FOTOS - (f.fotos || []).length;
    if (plads <= 0) { setFejl(`Der kan højst være ${TILBUD_MAKS_FOTOS} billeder.`); return; }
    const valgte = Array.from(filer).slice(0, plads);
    const nye = [];
    for (let i = 0; i < valgte.length; i++) {
      setFotoArbejde({ nr: i + 1, iAlt: valgte.length });
      try {
        // Genbruger komprimeringen fra opgavefotos. Ti raa kamerabilleder fra en
        // kundes kontor er 50 MB op gennem mobilnettet.
        const blob = await komprimerBillede(valgte[i]);
        const sti = `${tilbud.id}/fotos/${Date.now()}-${i}.jpg`;
        const { error } = await supabaseClient.storage.from("tilbud")
          .upload(sti, blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw new Error(error.message);
        nye.push(sti);
      } catch (e) {
        setFejl("Kunne ikke sende billedet: " + (e?.message || e));
        break;
      }
    }
    setFotoArbejde(null);
    if (nye.length) {
      const alle = [...(f.fotos || []), ...nye];
      saet("fotos", alle);
      await supabaseClient.from("tilbud").update({ fotos: alle }).eq("id", tilbud.id);
    }
  }

  async function dannOgSend() {
    setFejl(""); setBesked("");
    if (!(f.kunde_email || "").trim()) { setFejl("Skriv kundens e-mail først."); return; }
    setGemmer(true);

    const n = tilbud.offentlig_noegle || Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!(await gem({ offentlig_noegle: n, status: "sendt", sendt_at: new Date().toISOString() }))) {
      setGemmer(false); return;
    }
    const { data: pdfSvar, error: pdfFejl } = await supabaseClient.functions
      .invoke("tilbud-pdf", { body: { tilbudId: tilbud.id } });
    if (pdfFejl || pdfSvar?.error) { setGemmer(false); setFejl(pdfSvar?.error || pdfFejl.message); return; }

    const link = `https://jammerbugtrengoering-kundeportal.netlify.app/tilbud/${n}`;
    const { error: mailFejl } = await supabaseClient.functions.invoke("send-email", {
      body: {
        email: (f.kunde_email || "").trim(),
        name: (f.kontaktperson || "").trim() || (f.kunde_navn || "").trim(),
        subject: "Tilbud fra Jammerbugt Rengøring",
        html: `<p>Hej ${(f.kontaktperson || "").trim()}</p>`
          + `<p>Her er vores tilbud på ${(f.titel || "rengøring").trim()}.</p>`
          + `<p><a href="${link}">Åbn tilbuddet og accepter her</a></p>`
          + `<p>Med venlig hilsen<br/>Jammerbugt Rengøring</p>`,
      },
    });
    setGemmer(false);
    setTilbud((t) => ({ ...t, offentlig_noegle: n, status: "sendt" }));
    setBesked(mailFejl
      ? "Tilbuddet er gemt og markeret som sendt, men mailen kunne ikke afsendes. Prøv igen fra kontoret."
      : "Tilbuddet er sendt til kunden.");
  }

  if (henter) return (
    <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
      <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}><div style={{ padding: 40, textAlign: "center", color: "#94A3B8" }}>Indlæser…</div></div>
    </div>
  );

  if (!tilbud) return (
    <div style={s.overlay} onClick={onLuk}>
      <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={s.afslutTop}>{task.title}</div>
        <div style={{ padding: 24, textAlign: "center", color: "#64748B", fontSize: 14, lineHeight: 1.5 }}>
          Der hører ikke noget tilbud til denne aktivitet.
        </div>
        <div style={{ padding: 16 }}>
          <button style={s.sekundaerStor} onClick={onLuk}>Luk</button>
        </div>
      </div>
    </div>
  );

  const laast = tilbud.status === "accepteret";
  const felt = { ...s.notatInput, marginTop: 6 };

  return (
    <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
      <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}>
        {/* Tilbage-knap som paa de andre skaerme. Uden den var der ingen vej ud af
            tilbuddet uden at gemme — og et tryk udenfor lukker heller ikke, fordi
            skaermen ligger inde i opgavens overlay. */}
        <div style={s.afslutTop}>
          <button style={s.afslutTilbage} onClick={luk}>
            <ChevronLeft size={16} /> Tilbage
          </button>
          <span style={{ opacity: 0.8 }}>{f.kunde_navn || task.title}</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 20px" }}>

          {laast && (
            <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 9,
                          padding: 11, fontSize: 13, color: "#166534", marginBottom: 14, lineHeight: 1.5 }}>
              Kunden har accepteret. Tilbuddet kan ikke længere rettes.
            </div>
          )}

          <div style={s.tilbudAfsnit}>Kunden</div>
          <input style={felt} value={f.kunde_navn} disabled={laast}
            onChange={(e) => saet("kunde_navn", e.target.value)} placeholder="Virksomhedens navn" />
          <AdresseFelt felt={felt} vaerdi={f.adresse} disabled={laast}
            onChange={(v) => saet("adresse", v)} placeholder="Adresse" />
          <input style={felt} value={f.kontaktperson} disabled={laast}
            onChange={(e) => saet("kontaktperson", e.target.value)} placeholder="Kontaktperson" />
          <input style={felt} type="email" inputMode="email" value={f.kunde_email} disabled={laast}
            onChange={(e) => saet("kunde_email", e.target.value)} placeholder="E-mail — tilbuddet sendes hertil" />

          <div style={s.tilbudAfsnit}>Referat</div>
          {/* Helt almindelig textarea med vilje: bygger man noget smart, holder baade
              diktering og systemets skriveværktøjer op med at virke. */}
          <textarea style={{ ...felt, minHeight: 150, resize: "vertical", lineHeight: 1.5 }}
            value={f.referat} disabled={laast}
            onChange={(e) => saet("referat", e.target.value)}
            placeholder="Hvad kunden ønsker, hvad I aftalte, hvad der er taget forbehold for…" />
          <div style={s.tilbudHint}>
            Tryk på mikrofonen på tastaturet og tal. Marker teksten bagefter for at få
            telefonen til at rydde op i den — det sker på telefonen, teksten sendes ingen steder hen.
          </div>

          <div style={s.tilbudAfsnit}>Billeder — {(f.fotos || []).length} af {TILBUD_MAKS_FOTOS}</div>
          {(f.fotos || []).length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6, marginBottom: 8 }}>
              {(f.fotos || []).map((sti) => (
                fotoUrls[sti]
                  ? <img key={sti} src={fotoUrls[sti]} alt="" style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 8 }} />
                  : <div key={sti} style={{ width: "100%", height: 80, borderRadius: 8, background: "#F1F5F9" }} />
              ))}
            </div>
          )}
          {fotoArbejde && (
            <div style={{ fontSize: 12.5, color: "#4F46E5", marginBottom: 6 }}>
              Sender billede {fotoArbejde.nr} af {fotoArbejde.iAlt}…
            </div>
          )}
          {!laast && (f.fotos || []).length < TILBUD_MAKS_FOTOS && (
            <label style={{ ...s.sekundaerStor, display: "block", textAlign: "center", cursor: "pointer" }}>
              📷 Tilføj billeder
              <input type="file" accept="image/*" multiple style={{ display: "none" }}
                onChange={(e) => { tilfoejFotos(e.target.files); e.target.value = ""; }} />
            </label>
          )}

          <div style={s.tilbudAfsnit}>Pris</div>
          <select style={felt} value={f.contract_type} disabled={laast}
            onChange={(e) => {
              saet("contract_type", e.target.value);
              // Satsen foelger kontrakttypen. Ellers skulle hun huske fire priser udenad
              // mens hun sidder over for kunden.
              if (f.pricing_type === "hourly" && priser[e.target.value]) saet("timepris", priser[e.target.value]);
            }}>
            <option value="privat">Privat</option>
            <option value="erhverv">Erhverv</option>
            <option value="aeldrelov">Ældrelov</option>
            <option value="nexus">Kommunal (Nexus)</option>
          </select>

          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {[["hourly", "Timepris"], ["fixed", "Fast pris"]].map(([k, l]) => (
              <button key={k} type="button" disabled={laast} onClick={() => {
                saet("pricing_type", k);
                // Skifter hun tilbage til timepris efter at have prøvet fast pris,
                // skal satsen være der igen — ikke et tomt felt.
                if (k === "hourly" && !f.timepris && priser[f.contract_type]) {
                  saet("timepris", priser[f.contract_type]);
                }
              }}
                style={{ flex: 1, padding: "12px 10px", borderRadius: 10, fontSize: 14, fontWeight: 700,
                         border: f.pricing_type === k ? "2px solid #D6247A" : "1.5px solid #E2E8F0",
                         background: f.pricing_type === k ? "#FCE4EF" : "#fff",
                         color: f.pricing_type === k ? "#9C1B5D" : "#475569" }}>{l}</button>
            ))}
          </div>

          {f.pricing_type === "hourly" ? (
            <input style={felt} type="number" inputMode="decimal" value={f.timepris} disabled={laast}
              onChange={(e) => saet("timepris", e.target.value)} placeholder="Timepris i kr" />
          ) : (
            <input style={felt} type="number" inputMode="decimal" value={f.fast_pris} disabled={laast}
              onChange={(e) => saet("fast_pris", e.target.value)} placeholder="Fast pris pr. besøg i kr" />
          )}
          <input style={felt} type="number" inputMode="decimal" step="0.25" value={f.anslaaet_timer} disabled={laast}
            onChange={(e) => saet("anslaaet_timer", e.target.value)} placeholder="Anslået tid pr. besøg i timer" />
          <select style={felt} value={f.plan_interval} disabled={laast}
            onChange={(e) => saet("plan_interval", e.target.value)}>
            <option value="uge">Hver uge</option>
            <option value="14_dage">Hver 14. dag</option>
            <option value="maaned">Hver måned</option>
          </select>

          <div style={s.tilbudAfsnit}>Ydelser</div>
          {lister.map((c) => {
            const paa = (f.checklist_template_ids || []).includes(c.id);
            return (
              <button key={c.id} type="button" disabled={laast}
                onClick={() => saet("checklist_template_ids", paa
                  ? f.checklist_template_ids.filter((x) => x !== c.id)
                  : [...(f.checklist_template_ids || []), c.id])}
                style={paa ? s.nexusTjekAktiv : s.nexusTjek}>
                <span style={paa ? s.tjekFirkantAktiv : s.tjekFirkant}>
                  {paa && <Check size={16} color="#fff" strokeWidth={3} />}
                </span>
                <span>{c.name} <span style={{ color: "#94A3B8" }}>· {c.antal} punkter</span></span>
              </button>
            );
          })}

          <div style={s.tilbudAfsnit}>Bemærkninger</div>
          <textarea style={{ ...felt, minHeight: 80, resize: "vertical", lineHeight: 1.5 }}
            value={f.bemaerkning} disabled={laast}
            onChange={(e) => saet("bemaerkning", e.target.value)}
            placeholder="Forbehold, særlige aftaler…" />

          {/* Moedet skal kunne hakkes af, saa kontoret kan se at det er holdt. Der
              registreres IKKE tid: et kundemoede faktureres ikke, og der er ingen
              kunde der betaler for timerne. Derfor er aktiviteter ogsaa undtaget fra
              den daglige paamindelse om manglende registrering. */}
          <div style={s.tilbudAfsnit}>Mødet</div>
          <button type="button"
            style={moedeHoldt ? s.nexusTjekAktiv : s.nexusTjek}
            onClick={async () => {
              const ok = await onSetStatus(task.id, !moedeHoldt);
              if (ok !== false) setMoedeHoldt((v) => !v);
            }}>
            <span style={moedeHoldt ? s.tjekFirkantAktiv : s.tjekFirkant}>
              {moedeHoldt && <Check size={16} color="#fff" strokeWidth={3} />}
            </span>
            <span>Mødet er holdt</span>
          </button>
          <div style={s.tilbudHint}>
            Der skal ikke registreres tid på et kundemøde. Fluebenet er kun så kontoret
            kan se at du har været der.
          </div>

          {fejl && <div style={{ ...s.notatFejl, marginTop: 12 }}>{fejl}</div>}
          {besked && <div style={{ color: "#166534", fontSize: 13.5, marginTop: 12, lineHeight: 1.5 }}>{besked}</div>}
        </div>

        <div style={{ padding: 14, borderTop: "1px solid #F1F5F9", display: "flex", gap: 8 }}>
          {/* Et accepteret tilbud maa ikke gemmes igen — det er dokumentationen for
              det kunden skrev under paa. Saa er knappen bare en udgang. */}
          <button style={{ ...s.sekundaerStor, flex: 1 }} onClick={laast ? onLuk : gemOgLuk} disabled={gemmer}>
            {gemmer ? "Gemmer…" : laast ? "Luk" : "Gem og luk"}
          </button>
          {!laast && (
            <button style={{ ...s.doneLarge, flex: 1, background: "#D6247A", color: "#fff", borderColor: "#D6247A", fontWeight: 700 }}
              onClick={dannOgSend} disabled={gemmer}>
              {tilbud.status === "sendt" ? "Send igen" : "Send til kunden"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Booker det naeste kundemoede mens hun staar hos kunden. Kun planlaeggere ser den —
// og databasen afviser kaldet uanset hvad, hvis den der spoerger ikke er administrator.
function NytMoedeSkaerm({ supabaseClient, employee, onLuk, onOprettet }) {
  const [kunde, setKunde] = useState("");
  const [adresse, setAdresse] = useState("");
  const [dato, setDato] = useState(() => new Date().toISOString().slice(0, 10));
  const [tid, setTid] = useState("10:00");
  const [minutter, setMinutter] = useState(60);
  const [arbejder, setArbejder] = useState(false);
  const [fejl, setFejl] = useState("");

  async function opret() {
    setFejl("");
    if (!kunde.trim()) { setFejl("Skriv hvem mødet er med."); return; }
    setArbejder(true);
    const { error } = await supabaseClient.rpc("opret_kundemoede", {
      p_kunde_navn: kunde.trim(), p_dato: dato, p_tid: tid || null,
      p_minutter: Number(minutter) || 60,
      p_adresse: adresse.trim() || null, p_emp_id: employee.id,
    });
    setArbejder(false);
    if (error) { setFejl(error.message); return; }
    onOprettet();
  }

  const felt = { ...s.notatInput, marginTop: 6 };

  return (
    <div style={s.overlay} onClick={onLuk}>
      <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={s.afslutTop}>Nyt kundemøde</div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
          <div style={s.tilbudHint}>
            Mødet lægges i din uge, så kontoret kan se at du er ude. Samtidig oprettes
            et tilbud i kladde, som du kan udfylde når du er derude.
          </div>
          <div style={s.tilbudAfsnit}>Hvem er mødet med?</div>
          <input style={felt} value={kunde} onChange={(e) => setKunde(e.target.value)}
            placeholder="Også hvis de ikke er kunde endnu" />
          <AdresseFelt felt={felt} vaerdi={adresse} onChange={setAdresse}
            placeholder="Adresse" />
          <div style={s.tilbudAfsnit}>Hvornår</div>
          <input style={felt} type="date" value={dato} onChange={(e) => setDato(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...felt, flex: 1 }} type="time" value={tid} onChange={(e) => setTid(e.target.value)} />
            <input style={{ ...felt, flex: 1 }} type="number" step="15" min="15" inputMode="numeric"
              value={minutter} onChange={(e) => setMinutter(e.target.value)} placeholder="Minutter" />
          </div>
          {fejl && <div style={s.notatFejl}>{fejl}</div>}
        </div>
        <div style={{ padding: 14, borderTop: "1px solid #F1F5F9", display: "flex", gap: 8 }}>
          <button style={{ ...s.sekundaerStor, flex: 1 }} onClick={onLuk}>Annullér</button>
          <button style={{ ...s.doneLarge, flex: 1, background: "#D6247A", color: "#fff", borderColor: "#D6247A", fontWeight: 700 }}
            onClick={opret} disabled={arbejder}>
            {arbejder ? "Opretter…" : "Opret møde"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Meld et problem ──────────────────────────────────────────────────────────
// Egen fuldskaerm, ikke et felt der klapper ud nederst paa opgaven. Foer laa de to
// valg under folden, saa man skulle scrolle for at opdage at man havde trykket paa
// noget — og en melding om at man ikke kan komme ind er ikke noget man skal lede efter.
function MeldProblem({ task, employee, lang, tr, supabaseClient, onAfbryd, onSendt }) {
  const synlig = useSynligHoejde();
  const [art, setArt] = useState(null);
  const [dato, setDato] = useState("");
  const [klokken, setKlokken] = useState("");
  const [grund, setGrund] = useState("");
  const [filer, setFiler] = useState([]);
  const [gemmer, setGemmer] = useState(false);
  const [fejl, setFejl] = useState("");
  const [fotoFremdrift, setFotoFremdrift] = useState(null);
  const [sendt, setSendt] = useState(null);

  // Id'erne laves EEN gang, naar skaermen aabnes — ikke inde i send(). Ellers faar
  // hvert forsoeg sit eget id, og en melding der fejlede halvvejs og bliver sendt igen
  // ville staa to gange hos kontoret. Med faste id'er og upsert nedenfor kan der
  // trykkes send saa mange gange det skal vaere: der staar én melding bagefter.
  const [notatId] = useState(() => nytId("tn"));
  const [oenskeId] = useState(() => nytId("rr"));

  const forgaeves = art === "forgaeves";
  const kanSende = grund.trim() && (forgaeves || dato);

  async function send() {
    if (!kanSende) return;
    setGemmer(true);
    setFejl("");
    try {
      // Notatet foerst: det er dét der baerer billederne, og kontoret skal kunne se
      // dokumentationen ved siden af opgaven — ogsaa efter meldingen er lukket.
      let stier = [];
      if (forgaeves) {
        // upsert og ikke insert: id'et er fast, saa et gentaget forsoeg overskriver
        // den samme raekke i stedet for at lave en dublet.
        const { error: insErr } = await supabaseClient.from("task_notes").upsert({
          id: notatId, instance_id: task.id, employee_id: employee?.id || null,
          kind: "forgaeves", text: grund.trim(), photos: [],
        }, { onConflict: "id" });
        if (insErr) throw new Error(insErr.message);
        if (filer.length > 0) {
          stier = await uploadOpgavefotos(supabaseClient, task.id, notatId, filer,
            (nr, iAlt) => setFotoFremdrift({ nr, iAlt }));
          const { error: updErr } = await supabaseClient
            .from("task_notes").update({ photos: stier }).eq("id", notatId);
          if (updErr) throw new Error(updErr.message);
        }
      }
      const { error } = await supabaseClient.from("reschedule_requests").upsert({
        id: oenskeId,
        instance_id: task.id,
        employee_id: employee?.id || null,
        kind: forgaeves ? "forgaeves" : "ny_tid",
        // Notatet oprettes kun ved forgaeves besoeg. Id'et findes altid, fordi det
        // laves naar skaermen aabnes — men det maa kun skrives her hvis raekken
        // faktisk er oprettet ovenfor.
        note_id: forgaeves ? notatId : null,
        requested_date: dato || null,
        requested_time: klokken || null,
        reason: grund.trim(),
        old_year: task.year, old_week: task.week, old_day: task.day,
        old_time: task.scheduled_time || null,
      }, { onConflict: "id" });
      if (error) throw new Error(error.message);

      // Backoffice skal vide det med det samme — de kigger ikke nødvendigvis i appen.
      const { data: adm } = await supabaseClient.from("employees")
        .select("name,app_email").eq("is_admin", true).not("app_email", "is", null);
      const naar = dato ? dato + (klokken ? " kl. " + klokken : "") : "";
      for (const a of (adm || [])) {
        await supabaseClient.functions.invoke("send-email", { body: {
          email: a.app_email, name: a.name,
          subject: forgaeves
            ? "Forgæves besøg: " + (task.title || "opgave")
            : "Ønske om ny tid: " + (task.title || "opgave"),
          html: forgaeves
            ? `<p><b>${employee?.name || "En medarbejder"}</b> kunne ikke komme ind og fik ikke udført opgaven.</p>` +
              `<p><b>Opgave:</b> ${task.title || ""}<br/><b>Kunde:</b> ${task.customerName || ""}</p>` +
              `<p><b>Hvad skete der:</b><br/>${grund.trim()}</p>` +
              (stier.length > 0 ? `<p>Der er vedhæftet ${stier.length} billede(r) i planlægningsappen.</p>` : "") +
              (naar ? `<p><b>Foreslået ny tid:</b> ${naar}</p>` : "") +
              `<p>Åbn ugeplanen og afgør om opgaven skal flyttes, eller sættes til udført så den kan faktureres.</p>`
            : `<p><b>${employee?.name || "En medarbejder"}</b> har aftalt en ny tid med kunden og beder om at få opgaven flyttet.</p>` +
              `<p><b>Opgave:</b> ${task.title || ""}<br/><b>Kunde:</b> ${task.customerName || ""}<br/>` +
              `<b>Ønsket:</b> ${naar}</p><p><b>Begrundelse:</b><br/>${grund.trim()}</p>` +
              `<p>Åbn ugeplanen for at godkende eller afvise.</p>`,
        }});
      }
      setSendt(forgaeves ? "forgaeves" : "ny_tid");
      // Betingelsen er «forgaeves» og ikke «har vi et notat-id». Id'et laves nu naar
      // skaermen aabnes, saa det er altid sat — men notatet oprettes kun ved forgaeves
      // besoeg. Uden rettelsen ville et oenske om ny tid melde et notat tilbage der
      // ikke findes i databasen.
      onSendt(forgaeves ? "forgaeves" : "ny_tid", forgaeves
        ? { id: notatId, instance_id: task.id, employee_id: employee?.id || null,
            kind: "forgaeves", text: grund.trim(), photos: stier,
            created_at: new Date().toISOString() }
        : null);
    } catch (e) {
      setFejl(e?.message || String(e));
    }
    setFotoFremdrift(null);
    setGemmer(false);
  }

  if (sendt) {
    return (
      <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}>
          <div style={s.afslutTop}>{task.customerName || task.title}</div>
          <div style={{ flex: 1, overflowY: "auto", padding: "28px 20px", textAlign: "center" }}>
            <div style={s.kvitteringCirkel}><Check size={34} color="#16A34A" strokeWidth={3} /></div>
            <div style={s.kvitteringTitel}>{tr.reportSentTitle}</div>
            <div style={{ ...s.trinHjaelp, marginTop: 10 }}>
              {sendt === "forgaeves" ? tr.reportSentNoEntry : tr.reportSentNewTime}
            </div>
          </div>
          <div style={s.afslutBund}>
            <button style={s.primaerStor} onClick={onAfbryd}>{tr.reportBackToTask}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
      <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}>
        <div style={s.afslutTop}>
          <button style={s.afslutTilbage} onClick={() => (art ? setArt(null) : onAfbryd())}>
            <ChevronLeft size={16} /> {tr.back}
          </button>
          <span>{task.customerName || ""}</span>
        </div>

        {/* scrollPaddingBottom giver browseren lov til at rulle feltet fri af
            tastaturet af sig selv, naar det faar fokus. Uden det staar markoeren
            praecis paa kanten. */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 16px 20px",
                      scrollPaddingBottom: 120, WebkitOverflowScrolling: "touch" }}>
          {!art ? (
            <>
              <div style={s.trinSpoergsmaal}>{tr.reportProblemTitle}</div>
              <div style={s.trinHjaelp}>{tr.reportProblemHint}</div>
              {/* Store kort med forklaring under, ikke to knapper med tre ord.
                  Valget mellem "flyt den" og "jeg kom ikke ind" skal vaere til at
                  traeffe uden at gaette hvad kontoret gør med det bagefter. */}
              <button style={s.valgKortGul} onClick={() => { setArt("ny_tid"); setGrund(""); }}>
                <div style={s.valgKortTitel}>🕑 {tr.reportNewTime}</div>
                <div style={s.valgKortTekst}>{tr.reportNewTimeCard}</div>
              </button>
              <button style={s.valgKortRoed} onClick={() => { setArt("forgaeves"); setGrund(""); setDato(""); setKlokken(""); }}>
                <div style={s.valgKortTitel}>🚫 {tr.reportNoEntry}</div>
                <div style={s.valgKortTekst}>{tr.reportNoEntryCard}</div>
              </button>
            </>
          ) : forgaeves ? (
            <>
              <div style={s.trinSpoergsmaal}>{tr.reportNoEntryWhy}</div>
              <div style={s.trinHjaelp}>{tr.reportNoEntryHint}</div>
              <textarea rows={4} value={grund} onChange={(e) => setGrund(e.target.value)}
                placeholder={tr.reportNoEntryPlaceholder}
                style={{ ...s.notatInput, marginTop: 12 }} />
              <div style={{ marginTop: 12 }}>
                <FotoVaelger filer={filer} setFiler={setFiler} farve="#991B1B" tr={tr} />
              </div>
              <div style={{ ...s.stepperLabel, marginTop: 16 }}>{tr.reportNewDateOptional}</div>
              <input type="date" value={dato} onChange={(e) => setDato(e.target.value)}
                style={s.datoFelt} />
            </>
          ) : (
            <>
              <div style={s.trinSpoergsmaal}>{tr.reportNewTimeQ}</div>
              <div style={s.trinHjaelp}>{tr.reportNewTimeHint}</div>
              <div style={{ ...s.stepperLabel, marginTop: 14 }}>{tr.reportNewDate}</div>
              <input type="date" value={dato} onChange={(e) => setDato(e.target.value)} style={s.datoFelt} />
              <div style={{ ...s.stepperLabel, marginTop: 12 }}>{tr.reportNewClock}</div>
              <input type="time" value={klokken} onChange={(e) => setKlokken(e.target.value)} style={s.datoFelt} />
              <div style={{ ...s.stepperLabel, marginTop: 12 }}>{tr.reportWhyMove}</div>
              <textarea rows={3} value={grund} onChange={(e) => setGrund(e.target.value)}
                placeholder={tr.reportWhyMovePlaceholder} style={s.notatInput} />
            </>
          )}
          {fejl && <div style={s.notatFejl}>{fejl}</div>}
        </div>

        {art && (
          <div style={s.afslutBund}>
            <button
              disabled={!kanSende || gemmer}
              style={{ ...s.primaerStor,
                background: forgaeves ? "#B91C1C" : "#B45309",
                opacity: (!kanSende || gemmer) ? 0.45 : 1 }}
              onClick={send}>
              {gemmer
                ? (fotoFremdrift ? `${tr.notesPhotoProgress} ${fotoFremdrift.nr}/${fotoFremdrift.iAlt}` : tr.reportSending)
                : tr.reportSend}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Afslut opgave ────────────────────────────────────────────────────────────
// Alt der skal registreres, samlet ét sted og ét spoergsmaal ad gangen. Foer laa
// tidsregistrering, produkter og kommentarfelt paa selve opgaveskaermen, hvor de
// stod og forstyrrede mens arbejdet blev udfoert — og afslut-knappen laa nederst
// efter dem alle. Nu ser man opgaven mens man arbejder, og registrerer bagefter.
//
// Flowet kan gennemloebes flere gange paa samme opgave. Tiden laegges oveni det der
// allerede staar, saa en pause midt i arbejdet eller to medarbejdere paa samme
// opgave fungerer praecis som foer.
function AfslutOpgave({ task, employee, lang, tr, supabaseClient, fraListe, onLogMinutes, onSetStatus, onAfbryd, onFaerdig }) {
  const synlig = useSynligHoejde();
  const erNexus = task.contractType === "nexus";

  // Produkter udleveres paa KONTORET af planlaeggeren. Medarbejderen vaelger altsaa
  // ikke laengere varer her — hun BEKRAEFTER at kunden har faaet det hun fik med.
  //
  // null betyder "ikke slaaet op endnu". Trinnene maa ikke bygges foer svaret er
  // hjemme: aendrede listen sig undervejs, ville trinNr pege paa et andet trin end
  // det hun stod paa.
  const [udleveringer, setUdleveringer] = useState(null);
  const [udleverBekraeftet, setUdleverBekraeftet] = useState(null);

  useEffect(() => {
    let afbrudt = false;
    (async () => {
      const guid = task.dinero_contact_guid;
      if (!guid) { setUdleveringer([]); return; }
      // Udleveringen peger ikke paa en bestemt opgave. Den findes paa medarbejder plus
      // kunde, saa den dukker op uanset hvilken opgave hos kunden hun naar frem til.
      const { data } = await supabaseClient
        .from("inventory_transactions")
        .select("id, quantity, item_id, udleveret_dato, inventory_items(name, unit)")
        .eq("employee_id", employee.id)
        .eq("til_kunde_guid", guid)
        .is("instance_id", null);
      if (!afbrudt) setUdleveringer(data || []);
    })();
    return () => { afbrudt = true; };
  }, [task.id, task.dinero_contact_guid, employee.id, supabaseClient]);

  // Trinnene bygges op efter opgaven, saa taellingen "3 af 4" passer til det man
  // faktisk faar at se. En erhvervsopgave spoerges ikke om Nexus, og har hun ingen
  // varer med til kunden, er der ingen grund til at spoerge om produkter.
  const spoergOmProdukter = (udleveringer?.length || 0) > 0;
  const trin = [
    "tid",
    ...(spoergOmProdukter ? ["produkter"] : []),
    ...(erNexus ? ["nexus"] : []),
    "besked",
  ];

  const [trinNr, setTrinNr] = useState(0);
  const [gemmer, setGemmer] = useState(false);
  const [fejl, setFejl] = useState("");
  const [kvittering, setKvittering] = useState(null);

  // Tiden starter paa det planlagte. Det er svaret i de fleste tilfaelde, saa den
  // almindelige dag kraever ingen indtastning — kun et tryk paa Videre.
  const alleredeLogget = (task.timeLog || []).reduce((s, l) => s + (l.minutes || 0), 0);
  // Varigheden er tiden PR. PERSON. Er der to paa opgaven, er der ogsaa afsat dobbelt
  // saa meget arbejde i alt — ellers ville to der begge gjorde praecis som planlagt
  // faa besked om at de havde overskredet tiden med 100 %.
  const antalPaa = Math.max(1, (task.assignees || []).length);
  // HENDES andel, ikke opgavens varighed. Er timerne fordelt — fx ti timer delt
  // fire-fire-to — skal hendes skaerm starte paa hendes egne fire timer. Ellers ville
  // hun faa gennemsnittet foreslaaet og se ud til at overskride med det samme.
  //
  // Er der ikke fordelt, er andelen opgavens varighed, praecis som foer.
  const fordeling = task.tidFordeling || task.tid_fordeling || {};
  const minEgenTid = Number(fordeling[employee.id]) > 0
    ? Math.round(Number(fordeling[employee.id]))
    : (task.duration || 0);
  // Alt planlagt arbejde paa opgaven: summen af andelene, hvis der er fordelt.
  const planlagt = Object.keys(fordeling).length > 0
    ? (task.assignees || []).reduce((sum, id) => sum
        + (Number(fordeling[id]) > 0 ? Math.round(Number(fordeling[id])) : (task.duration || 0)), 0)
    : minEgenTid * antalPaa;
  // Hvad HUN selv har registreret. Startvaerdien skal vaere hendes egen resterende
  // tid, ikke opgavens — ellers ville hun faa kollegaens andel foreslaaet.
  const migLoggede = (task.timeLog || [])
    .filter((l) => l.empId === employee.id).reduce((s, l) => s + (l.minutes || 0), 0);

  // Én tilstand i samlede minutter, ikke to. Med timer og minutter hver for sig skal
  // 55 + 5 baade nulstille minutterne og laegge en time til, og 0 − 5 skal blokeres
  // hvis der ikke er en time at tage af — to afhaengige tilstande der kan komme i
  // utakt. Med ét tal er begge dele almindelig plus og minus.
  //
  // Startvaerdien er det der er TILBAGE af det planlagte, ikke hele varigheden. Er
  // der allerede registreret tid — af en kollega, eller af hende selv foer en pause —
  // ville hele varigheden vaere en overskridelse fra foerste sekund, og hun ville
  // blive tvunget til at skrive en begrundelse for noget der passer fint.
  // Startvaerdien rundes IKKE laengere til naermeste fem. Er der 18 minutter tilbage
  // af det planlagte, skal der staa 18 - ikke 20. Afrundingen var der, fordi
  // vaelgeren kun kunne det, og nu kan den mere.
  const [samletMin, setSamletMin] = useState(Math.max(0, Math.round(minEgenTid - migLoggede)));
  const timer = Math.floor(samletMin / 60);
  const minutter = samletMin % 60;
  const [begrundelse, setBegrundelse] = useState("");
  const [begrundelseFejl, setBegrundelseFejl] = useState(false);


  const [nexusOk, setNexusOk] = useState(false);

  const [beskedTekst, setBeskedTekst] = useState("");
  const [beskedFiler, setBeskedFiler] = useState([]);
  const [fotoFremdrift, setFotoFremdrift] = useState(null);

  // Id'et laves naar afslutningsskaermen aabnes og ikke ved hvert forsoeg paa at gemme.
  // Fejler afslutningen halvvejs og hun proever igen, rammer upsert'en den samme raekke
  // — og fotostierne, der bygges paa notat-id'et, peger ogsaa samme sted.
  const [notatId] = useState(() => nytId("tn"));

  // Egen noegle til tidsregistreringen. tidErGemt nedenfor spaerrer inden for DENNE
  // skaerm, men forsvinder hvis siden genindlaeses eller telefonen genstarter midt i
  // det hele. Noeglen ligger i databasen og holder ogsaa der.
  const [tidNoegle] = useState(() => nytId("tl"));

  const minutterIAlt = samletMin;
  // Overskridelsen maales paa opgavens samlede tid, ikke paa den enkelte medarbejders.
  // Varigheden er planlagt for hele opgaven, saa to personer paa en time hver har
  // brugt to timer af noget der maaske kun var sat til halvanden.
  const iAltPaaOpgaven = alleredeLogget + minutterIAlt;
  const afvigelse = iAltPaaOpgaven - planlagt;
  // Er der ingen planlagt varighed, findes der ingen overskridelse at begrunde.
  // Og tilfoejer hun ingen tid, er der heller ikke noget nyt at forklare — den tid
  // der allerede staar, er begrundet dengang den blev registreret.
  const overskrider = planlagt > 0 && afvigelse > 0 && minutterIAlt > 0;

  // Loftet paa 12 timer er det samme som i den gamle timevaelger. Nedad stopper vi
  // ved 0 — en registrering paa nul minutter afvises alligevel af naeste trin.
  // Selve regnestykket ligger i src/tidsfelt.js med sin egen test. Her er kun
  // koblingen til skaermen — tallet bliver til loen og til en regning, saa reglen
  // skal kunne proeves af uden at aabne en telefon.
  function skift(delta) { setFejl(""); setSamletMin((v) => skiftTid(v, delta)); }
  function saetTimerFelt(v) { setFejl(""); setSamletMin((nu) => saetTimer(nu, v)); }
  function saetMinutterFelt(v) { setFejl(""); setSamletMin((nu) => saetMinutter(nu, v)); }

  function videre() {
    setFejl("");
    if (trin[trinNr] === "tid") {
      // Kravet om tid gaelder kun foerste gang. Aabner hun opgaven igen — fx for at
      // tilfoeje et billede efter at have fortrudt en afslutning — er tiden allerede
      // registreret, og at kraeve mere ville faa timerne til at vokse uden grund.
      if (minutterIAlt <= 0 && alleredeLogget <= 0) { setFejl(tr.finishNeedTime); return; }
      if (overskrider && !begrundelse.trim()) { setBegrundelseFejl(true); return; }
    }
    // Der er ikke noget forvalgt ja. Varer der faktureres til en kunde som aldrig fik
    // dem, er en regning der skal krediteres — saa hun skal svare, ikke bare trykke
    // Videre. «Nej» er et fuldgyldigt svar og spaerrer ikke.
    if (trin[trinNr] === "produkter" && udleverBekraeftet === null) {
      setFejl(tr.finishHandoverRequired);
      return;
    }
    // Fejlmarkeringen nulstilles ved skift af trin. Ellers stod den roede ramme og
    // lyste naar man gik tilbage til tiden igen, uden at man havde trykket paa noget.
    setBegrundelseFejl(false);
    setTrinNr((n) => n + 1);
  }

  // Huskes paa tvaers af forsoeg. Fejler fotouploaden efter at tiden er skrevet, maa
  // et nyt tryk paa Afslut ikke logge tiden igen — append_time_log laegger til, saa
  // to forsoeg ville blive to registreringer paa den samme opgave.
  const tidErGemt = useRef(false);

  async function afslut() {
    setGemmer(true);
    setFejl("");
    try {
      if (minutterIAlt > 0 && !tidErGemt.current) {
        const ok = await onLogMinutes(task.id, minutterIAlt,
          overskrider ? begrundelse.trim() : null, tidNoegle);
        if (ok === false) throw new Error(tr.finishSaveFailed);
        tidErGemt.current = true;
      }
      // Kommentar og billeder gemmes som et notat, praecis som fra opgaveskaermen.
      //
      // Fra her og ned laegges alt i koeen hvis forbindelsen svigter, i stedet for at
      // kaste. Tiden er allerede registreret paa dette tidspunkt, og at vaelte hele
      // afslutningen fordi et billede ikke kunne sendes ville tvinge hende til at
      // starte forfra — med risiko for at tiden blev talt med to gange.
      let antalFotos = 0;
      if (beskedTekst.trim() || beskedFiler.length > 0) {
        const raekke = {
          id: notatId, instance_id: task.id, employee_id: employee?.id || null,
          kind: "kommentar", text: beskedTekst.trim() || null, photos: [],
        };
        const { error: insErr } = await supabaseClient
          .from("task_notes").upsert(raekke, { onConflict: "id" });
        if (insErr && !erNetvaerksfejl(insErr)) throw new Error(insErr.message);

        // Billederne komprimeres UANSET om der er daekning. Det er den tunge del, og
        // den skal vaere overstaaet inden de gemmes i koeen — ellers laa der raa
        // billeder fra kameraet og fyldte telefonen.
        const stier = [];
        const koeFotos = [];
        for (let i = 0; i < beskedFiler.length; i++) {
          setFotoFremdrift({ nr: i + 1, iAlt: beskedFiler.length });
          const blob = await komprimerBillede(beskedFiler[i]);
          const sti = `${task.id}/${notatId}-${i}.jpg`;
          stier.push(sti);
          koeFotos.push({ sti, blob });
        }
        antalFotos = stier.length;

        if (insErr) {
          await koeTilfoej({ art: "notat", args: { raekke } });
          for (const f of koeFotos) await koeTilfoej({ art: "foto", args: f });
          if (stier.length) await koeTilfoej({ art: "fotostier", args: { notatId, stier } });
        } else if (koeFotos.length > 0) {
          let fotoFejl = null;
          for (const f of koeFotos) {
            const { error } = await supabaseClient.storage.from("opgavefotos")
              .upload(f.sti, f.blob, { contentType: "image/jpeg", upsert: false });
            const findes = error && (String(error.statusCode) === "409" || /exists/i.test(error.message || ""));
            if (error && !findes) { fotoFejl = error; break; }
          }
          if (fotoFejl && !erNetvaerksfejl(fotoFejl)) throw new Error(fotoFejl.message);
          if (fotoFejl) {
            for (const f of koeFotos) await koeTilfoej({ art: "foto", args: f });
            await koeTilfoej({ art: "fotostier", args: { notatId, stier } });
          } else {
            const { error: updErr } = await supabaseClient
              .from("task_notes").update({ photos: stier }).eq("id", notatId);
            if (updErr && !erNetvaerksfejl(updErr)) throw new Error(updErr.message);
            if (updErr) await koeTilfoej({ art: "fotostier", args: { notatId, stier } });
          }
        }
      }
      // Nexus-kvitteringen er ikke en spaerring, men den skal registreres — ogsaa
      // naar fluebenet IKKE er sat, saa kontoret kan foelge op paa netop de opgaver.
      //
      // Her blev der kastet ved alt andet end netvaerksfejl, og det kostede seks
      // opgaver mellem 24. august og 10. september: vagten paa instances kendte ikke
      // nexus_confirmed og afviste skrivningen med 42501. Fordi kastet skete FOER
      // onSetStatus, blev opgaven aldrig lukket. Tiden var registreret, opgaven stod
      // som planlagt, og kunden fik ingen regning — for et flueben der udtrykkeligt
      // ikke maa spaerre for noget.
      //
      // Derfor: kvitteringen kan aldrig vaelte afslutningen. Gaar skrivningen ikke
      // igennem, ryger den i koeen. Afviser databasen den ogsaa der, smider koeen den
      // vaek og skriver i konsollen — og opgaven er stadig lukket, hvilket er det der
      // baerer loen, koersel og fakturering.
      if (erNexus) {
        const { error: nxErr } = await supabaseClient
          .from("instances").update({ nexus_confirmed: nexusOk }).eq("id", task.id);
        if (nxErr) await koeTilfoej({ art: "nexus", args: { opgaveId: task.id, bekraeftet: nexusOk } });
      }
      // Bekraeftelsen binder udleveringen til DENNE opgave, og foerst der kan varerne
      // faktureres. Siger hun nej, roeres der ingenting: udleveringen bliver staaende
      // og dukker op igen naeste gang hun er hos kunden.
      let udleveret = 0;
      if (spoergOmProdukter && udleverBekraeftet === true) {
        const { data: antal, error: udErr } = await supabaseClient
          .rpc("bekraeft_udlevering", { p_instance_id: task.id });
        if (udErr && !erNetvaerksfejl(udErr)) throw new Error(udErr.message);
        if (udErr) {
          // Gratis at gentage: den saetter instance_id paa linjer der ikke har et.
          // Anden gang rammer den nul raekker.
          await koeTilfoej({ art: "udlevering", args: { opgaveId: task.id } });
          udleveret = udleveringer.length;
        } else {
          udleveret = antal || 0;
        }
      }
      const statusOk = await onSetStatus(task.id, true);
      if (statusOk === false) throw new Error(tr.finishSaveFailed);
      setKvittering({
        minutter: alleredeLogget + minutterIAlt,
        produkter: udleveret,
        fotos: antalFotos,
        nexus: erNexus ? nexusOk : null,
      });
    } catch (e) {
      setFejl(e?.message || String(e));
    }
    setFotoFremdrift(null);
    setGemmer(false);
  }

  const aktuelt = trin[trinNr];
  const sidsteTrin = trinNr === trin.length - 1;

  // Vent til opslaget om udleveringer er hjemme, foer der tegnes noget. Ellers ville
  // trinlisten faa et trin mere midt i det hele, og trinNr ville pege paa et andet
  // skridt end det hun stod paa — hun ville se noget skifte under fingeren.
  if (udleveringer === null) {
    return (
      <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}>
          <div style={s.afslutTop}>{task.customerName || task.title}</div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", fontSize: 15 }}>
            {tr.loading}
          </div>
        </div>
      </div>
    );
  }

  if (kvittering) {
    return (
      // stopPropagation er ikke pynt: flowet ligger inde i opgavens overlay, som
      // lukker paa klik. Uden den ville ethvert tryk paa plus, minus eller Videre
      // boble op og lukke hele opgaven med alt det indtastede.
      <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}>
          <div style={s.afslutTop}>{task.customerName || task.title}</div>
          <div style={{ flex: 1, overflowY: "auto", padding: "28px 20px", textAlign: "center" }}>
            <div style={s.kvitteringCirkel}><Check size={34} color="#16A34A" strokeWidth={3} /></div>
            <div style={s.kvitteringTitel}>{tr.finishDone}</div>
            <div style={s.kvitteringKunde}>{task.title}</div>
            <div style={s.kvitteringKort}>
              <div style={s.kvitteringRaekke}><span>{tr.timeTracking}</span><strong>{fmtMin(kvittering.minutter)}</strong></div>
              {(task.checklist || []).length > 0 && (
                <div style={s.kvitteringRaekke}>
                  <span>{tr.tasks}</span>
                  <strong>{(task.checklist || []).filter((i) => i.done).length}/{(task.checklist || []).length}</strong>
                </div>
              )}
              {kvittering.produkter > 0 && (
                <div style={s.kvitteringRaekke}><span>{tr.products}</span><strong>{kvittering.produkter}</strong></div>
              )}
              {kvittering.fotos > 0 && (
                <div style={s.kvitteringRaekke}><span>{tr.photos}</span><strong>{kvittering.fotos}</strong></div>
              )}
              {kvittering.nexus !== null && (
                <div style={s.kvitteringRaekke}>
                  <span>Nexus</span>
                  <strong style={{ color: kvittering.nexus ? "#16A34A" : "#B45309" }}>
                    {kvittering.nexus ? "✓ " + tr.nexusDone : tr.nexusMissing}
                  </strong>
                </div>
              )}
            </div>
            <div style={s.kvitteringNote}>{tr.finishKmNote}</div>
          </div>
          <div style={s.afslutBund}>
            {/* Knappen skal sige, hvor den foerer hen. Kom hun fra manglelisten,
                lander hun dér igen — og saa maa der ikke staa «dagens opgaver». */}
            <button style={s.primaerStor} onClick={onFaerdig}>
              {fraListe ? tr.finishNextList : tr.finishNext}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
      <div style={{ ...s.sheet, height: synlig.hoejde, maxHeight: synlig.hoejde,
                    marginTop: synlig.top, alignSelf: "flex-start" }}>
        <div style={s.afslutTop}>
          <button style={s.afslutTilbage} onClick={() => (trinNr === 0 ? onAfbryd() : setTrinNr((n) => n - 1))}>
            <ChevronLeft size={16} /> {tr.back}
          </button>
          <span>{trinNr + 1} {tr.ofSteps} {trin.length}</span>
        </div>
        <div style={s.fremdriftSpor}>
          <div style={{ ...s.fremdriftFyld, width: `${((trinNr + 1) / trin.length) * 100}%` }} />
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "18px 16px 20px" }}>
          {aktuelt === "tid" && (
            <>
              <div style={s.trinSpoergsmaal}>{tr.finishTimeQ}</div>
              <div style={s.trinHjaelp}>
                {tr.finishTimePlanned(fmtMin(minEgenTid))}
                {antalPaa > 1 && ` ${tr.finishPerPerson(antalPaa, fmtMin(planlagt))}`}
              </div>
              {/* Er der registreret tid i forvejen, skal det staa her. Ellers ser
                  maerkatet under det store tal ud som ren volapyk: "0t 30m" og
                  lige under "1t mere end planlagt". */}
              {alleredeLogget > 0 && (
                <div style={s.trinAllerede}>
                  {tr.finishAlready(fmtMin(alleredeLogget))}
                  {/* Uden denne saetning ser et nul ud som en fejl, og hun begynder at
                      lede efter tid at taste ind for at komme videre. */}
                  {minutterIAlt === 0 && ` ${tr.finishZeroOk}`}
                </div>
              )}

              <div style={{ textAlign: "center", margin: "18px 0 4px" }}>
                <div style={s.storTid}>
                  {timer}<span style={s.storTidEnhed}>t</span> {String(minutter).padStart(2, "0")}<span style={s.storTidEnhed}>m</span>
                </div>
                {planlagt > 0 && (
                  <div style={afvigelse === 0 ? s.maerkeOk : overskrider ? s.maerkeOver : s.maerkeUnder}>
                    {afvigelse === 0 ? tr.finishAsPlanned
                      : overskrider ? tr.finishMoreThan(fmtMin(afvigelse))
                      : tr.finishLessThan(fmtMin(-afvigelse))}
                  </div>
                )}
              </div>

              {/* Tallene kan bade trykkes op og ned OG skrives direkte.
                  Foer gik minutterne kun i spring af fem, og saa kunne 18 minutter
                  slet ikke registreres — hun maatte skrive 20, og lonnen og
                  fakturaen blev regnet paa noget, der ikke var sket.
                  De to felter skriver begge i samletMin, saa der er stadig KUN ét
                  tal bagved. To uafhaengige tilstande for timer og minutter er
                  praecis det, der gjorde 55 + 5 til et problem sidste gang. */}
              <div style={{ marginTop: 16 }}>
                <div style={s.stepperLabel}>{tr.finishHours}</div>
                <div style={s.stepperRaekke}>
                  <button style={s.stepperBtn} onClick={() => skift(-60)} aria-label="minus">−</button>
                  <input style={s.stepperFelt} type="number" inputMode="numeric" min="0" max="12"
                    value={timer}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => saetTimerFelt(e.target.value)}
                    aria-label={tr.finishHours} />
                  <button style={s.stepperBtn} onClick={() => skift(60)} aria-label="plus">+</button>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={s.stepperLabel}>{tr.finishMinutes}</div>
                <div style={s.stepperRaekke}>
                  <button style={s.stepperBtn} onClick={() => skift(-5)} aria-label="minus">−</button>
                  <input style={s.stepperFelt} type="number" inputMode="numeric" min="0" max="59"
                    value={minutter}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => saetMinutterFelt(e.target.value)}
                    aria-label={tr.finishMinutes} />
                  <button style={s.stepperBtn} onClick={() => skift(5)} aria-label="plus">+</button>
                </div>
              </div>

              {overskrider && (
                <div style={s.overrunBox}>
                  <div style={s.overrunTitle}>{tr.overrunTitle}</div>
                  <div style={s.overrunBody}>{tr.finishWhyMore}</div>
                  <textarea rows={2} value={begrundelse}
                    onChange={(e) => { setBegrundelse(e.target.value); if (e.target.value.trim()) setBegrundelseFejl(false); }}
                    placeholder={tr.overrunPlaceholder}
                    style={{ ...s.overrunInput, borderColor: begrundelseFejl ? "#DC2626" : "#F59E0B" }} />
                  {begrundelseFejl && <div style={s.overrunError}>{tr.overrunRequired}</div>}
                </div>
              )}
            </>
          )}

          {aktuelt === "produkter" && (
            <>
              <div style={s.trinSpoergsmaal}>{tr.finishHandoverQ}</div>
              <div style={s.trinHjaelp}>{tr.finishHandoverHint}</div>
              <div style={s.kvitteringKort}>
                {(udleveringer || []).map((u) => (
                  <div key={u.id} style={s.kvitteringRaekke}>
                    <span>{u.inventory_items?.name || u.item_id}</span>
                    <strong>{Math.abs(u.quantity)} {u.inventory_items?.unit || "stk"}</strong>
                  </div>
                ))}
              </div>
              {/* To lige store knapper og intet forvalgt. Hun skal tage stilling — et
                  forvalgt "ja" ville betyde at varer blev faktureret til en kunde der
                  aldrig fik dem, bare fordi hun trykkede Videre. */}
              <button
                style={udleverBekraeftet === true ? s.nexusTjekAktiv : s.nexusTjek}
                onClick={() => setUdleverBekraeftet(true)}>
                <span style={udleverBekraeftet === true ? s.tjekFirkantAktiv : s.tjekFirkant}>
                  {udleverBekraeftet === true && <Check size={16} color="#fff" strokeWidth={3} />}
                </span>
                <span>{tr.finishHandoverYes}</span>
              </button>
              <button
                style={udleverBekraeftet === false ? s.nexusTjekAktiv : s.nexusTjek}
                onClick={() => setUdleverBekraeftet(false)}>
                <span style={udleverBekraeftet === false ? s.tjekFirkantAktiv : s.tjekFirkant}>
                  {udleverBekraeftet === false && <Check size={16} color="#fff" strokeWidth={3} />}
                </span>
                <span>{tr.finishHandoverNo}</span>
              </button>
              <div style={s.trinFod}>{tr.finishHandoverFoot}</div>
            </>
          )}

          {aktuelt === "nexus" && (
            <>
              <div style={s.trinSpoergsmaal}>{tr.nexusQ}</div>
              <div style={s.trinHjaelp}>{tr.nexusHint}</div>
              <button style={s.nexusBtn} onClick={openNexusApp}>{tr.nexusOpenNow}</button>
              {/* Hele feltet er trykflade, ikke bare et lille afkrydsningsfelt.
                  Det skal kunne rammes med en behandsket finger. */}
              <button style={nexusOk ? s.nexusTjekAktiv : s.nexusTjek} onClick={() => setNexusOk((v) => !v)}>
                <span style={nexusOk ? s.tjekFirkantAktiv : s.tjekFirkant}>
                  {nexusOk && <Check size={16} color="#fff" strokeWidth={3} />}
                </span>
                <span>{tr.nexusConfirm}</span>
              </button>
              <div style={s.trinFod}>{tr.nexusSkipNote}</div>
            </>
          )}

          {aktuelt === "besked" && (
            <>
              <div style={s.trinSpoergsmaal}>{tr.finishNoteQ}</div>
              <div style={s.trinHjaelp}>{tr.finishNoteHint}</div>
              <textarea rows={3} value={beskedTekst} onChange={(e) => setBeskedTekst(e.target.value)}
                placeholder={tr.notesPlaceholder} style={{ ...s.notatInput, marginTop: 12 }} />
              <div style={{ marginTop: 8 }}>
                <FotoVaelger filer={beskedFiler} setFiler={setBeskedFiler} tr={tr} />
              </div>
            </>
          )}

          {fejl && <div style={s.notatFejl}>{fejl}</div>}
        </div>

        <div style={s.afslutBund}>
          {sidsteTrin ? (
            <button style={{ ...s.afslutBtn, opacity: gemmer ? 0.6 : 1 }} disabled={gemmer} onClick={afslut}>
              {gemmer
                ? (fotoFremdrift ? `${tr.notesPhotoProgress} ${fotoFremdrift.nr}/${fotoFremdrift.iAlt}` : tr.notesSending)
                : tr.finishTask}
            </button>
          ) : (
            <button style={s.primaerStor} onClick={videre}>{tr.finishNextStep}</button>
          )}
          {/* Kun naar der faktisk ikke er skrevet eller fotograferet noget. Ellers
              hed knappen "spring over" men gemte alligevel det man havde skrevet. */}
          {aktuelt === "besked" && !gemmer && !beskedTekst.trim() && beskedFiler.length === 0 && (
            <button style={s.springBtn} onClick={afslut}>{tr.finishNothingHappened}</button>
          )}
        </div>
      </div>

    </div>
  );
}

// ── Task detail modal ─────────────────────────────────────────────────────────
function TaskModal({ task, employee, lang, onClose, fraListe, onLogMinutes, onSetStatus, onToggleChecklist, supabaseClient }) {
  const tr = T[lang];
  const [translatedTask, setTranslatedTask] = useState(null);
  const [translating, setTranslating] = useState(false);
  // De to veje ud af denne skaerm: afslut opgaven, eller meld et problem.
  const [visAfslut, setVisAfslut] = useState(false);
  const [visProblem, setVisProblem] = useState(false);
  // Huskes efter meldingen er sendt, saa knappen erstattes af en kvittering. Ellers
  // ville hun ikke kunne se at kontoret allerede har faaet beskeden.
  const [problemSendt, setProblemSendt] = useState(null);
  // Adgangsoplysningen. null betyder "endnu ikke aabnet" — tom streng betyder "aabnet,
  // men der staar ingenting". De to skal kunne skelnes, ellers ville knappen dukke op
  // igen paa en opgave uden adgangsoplysninger, og hun ville tro det ikke virkede.
  const [adgangTekst, setAdgangTekst] = useState(null);
  const [adgangHenter, setAdgangHenter] = useState(false);
  const [adgangFejl, setAdgangFejl] = useState("");
  // Sand naar teksten kommer fra telefonens kopi og ikke fra et friskt opslag.
  const [adgangFraKopi, setAdgangFraKopi] = useState(false);
  // Gemte kommentarer og billeder vises her, men skrives i afslutningsflowet.
  const [noter, setNoter] = useState([]);
  const [fotoUrls, setFotoUrls] = useState({});
  const [fotoFremdrift, setFotoFremdrift] = useState(null);

  useEffect(() => {
    if (!task) return;
    if (lang === "da") { setTranslatedTask(null); return; }
    setTranslating(true);
    translateTask(task, lang).then((tt) => {
      setTranslatedTask(tt);
      setTranslating(false);
    });
  }, [task?.id, lang]);

  // Hent noterne paa opgaven, og signér billed-URL'erne med det samme. De udloeber
  // efter en time, hvilket er rigeligt for en opgave man har aabnet paa telefonen.
  useEffect(() => {
    if (!task?.id || !supabaseClient) return;
    let afbrudt = false;
    (async () => {
      const { data, error } = await supabaseClient
        .from("task_notes").select("*").eq("instance_id", task.id)
        .order("created_at", { ascending: false });
      if (afbrudt || error) return;
      setNoter(data || []);
      const alleStier = (data || []).flatMap((n) => n.photos || []);
      if (alleStier.length === 0) { setFotoUrls({}); return; }
      const urls = await signeredeFotoUrls(supabaseClient, alleStier);
      if (afbrudt) return;
      const kort = {};
      alleStier.forEach((sti, i) => { if (urls[i]) kort[sti] = urls[i]; });
      setFotoUrls(kort);
    })();
    return () => { afbrudt = true; };
  }, [task?.id, supabaseClient]);

  // Gemmer notatet foerst og billederne bagefter. Rækkefølgen er med vilje: notatets
  // id indgaar i filnavnet, og et notat uden billeder er stadig brugbart — mens et
  // billede uden et notat ville vaere hjemloest.
  async function gemNotat(art, tekst, filer) {
    // Her laves id'et pr. kald, for hvert notat ER et nyt notat. Idempotensen kommer
    // fra at id'et foelger med i skrivekoeen: sendes den samme koelinje igen, rammer
    // upsert'en den samme raekke i stedet for at lave en dublet.
    const notatId = nytId("tn");
    const { error: insErr } = await supabaseClient.from("task_notes").upsert({
      id: notatId, instance_id: task.id, employee_id: employee?.id || null,
      kind: art, text: (tekst || "").trim() || null, photos: [],
    }, { onConflict: "id" });
    if (insErr) throw new Error(insErr.message);
    let stier = [];
    if (filer && filer.length > 0) {
      stier = await uploadOpgavefotos(supabaseClient, task.id, notatId, filer,
        (nr, iAlt) => setFotoFremdrift({ nr, iAlt }));
      const { error: updErr } = await supabaseClient
        .from("task_notes").update({ photos: stier }).eq("id", notatId);
      if (updErr) throw new Error(updErr.message);
    }
    return { notatId, stier };
  }

  // Selve opslaget. Databasen afgoer om hun har adgang, skriver loggen, og svarer.
  // Appen har ingen anden vej til teksten — heller ikke ved at spoerge om opgaven igen.
  async function hentAdgang() {
    setAdgangHenter(true);
    setAdgangFejl("");
    const { data, error } = await supabaseClient.rpc("hent_adgangsinfo", { p_instance_id: task.id });
    if (error) {
      // Har hun hentet koden tidligere i dag, ligger den paa telefonen. Saa er der
      // ingen grund til at lade hende staa ved en laast doer uden at kunne komme ind —
      // opslaget ER logget, dengang hun hentede den.
      const gemt = laesAdgang(task.id);
      if (gemt !== null) {
        setAdgangTekst(gemt);
        setAdgangFraKopi(true);
      } else {
        setAdgangFejl(navigator.onLine ? tr.accessFailed : tr.accessOffline);
      }
    } else {
      setAdgangTekst(data ?? "");
      setAdgangFraKopi(false);
      gemAdgang(task.id, data ?? "");
    }
    setAdgangHenter(false);
  }

  if (!task) return null;
  // Brug oversat version hvis tilgængeligt, ellers original
  const t = translatedTask || task;
  const myLogged = (task.timeLog || []).filter((l) => l.empId === employee.id).reduce((s, l) => s + (l.minutes || 0), 0);
  const totalLogged = (task.timeLog || []).reduce((s, l) => s + (l.minutes || 0), 0);
  // Er hun med for at laere paa netop denne opgave? Det er kontoret der saetter det,
  // og kun paa den enkelte opgave — hun kan sagtens vaere fast paa sine egne samme uge.
  const migUnderOplaering = (task.oplaering || []).includes(employee.id);
  const done = !!((task.completed_by_employee || {})[employee.id]);
  const clProg = { done: (task.checklist || []).filter((i) => i.done).length, total: (task.checklist || []).length };
  const mapsUrl = task.address
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(task.address)}`
    : null;


  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={s.dragHandle} />
        <button style={s.sheetClose} onClick={onClose}><X size={18} /></button>
        <div style={s.sheetScroll}>

          {/* Status + contractType + title */}
          <div style={s.sheetStatusRow}>
            <span style={{ ...s.statusBadge, background: done ? "#ECFDF5" : "#FFF6FA", color: done ? "#16A34A" : "#9C1B5D" }}>
              {done ? "✓ " + tr.status["udført"] : task.status === "i_gang" ? "⚡ " + tr.status["i_gang"] : "⏳ " + tr.status["planlagt"]}
            </span>
            {task.contractType === "nexus" && (
              <span style={{ ...s.statusBadge, background: "#EEF2FF", color: "#4F46E5" }}>🏢 Nexus</span>
            )}
            {task.contractType === "privat" && (
              <span style={{ ...s.statusBadge, background: "#FFF6FA", color: "#9C1B5D" }}>🏠 {lang === "da" ? "Privat" : "Private"}</span>
            )}
            {task.contractType === "aeldrelov" && (
              <span style={{ ...s.statusBadge, background: "#FFF7ED", color: "#C2410C" }}>👴 Ældrelov</span>
            )}
            {translating && (
              <span style={{ ...s.statusBadge, background: "#F0FDF4", color: "#16A34A" }}>🌐 Oversætter…</span>
            )}
          </div>
          <div style={s.sheetTitle}>{t.title}</div>
          <div style={s.sheetMeta}>{fmtMin(t.duration)}{clProg.total > 0 ? ` · ${clProg.done}/${clProg.total} ${tr.tasks.toLowerCase()}` : ""}</div>

          {/* Ordlyden er vigtig. Ser hun bare «oplaering», er den naerliggende tanke
              at tiden saa ikke taeller — og saa holder hun op med at registrere den.
              Derfor staar loennen foerst og forklaringen bagefter. */}
          {migUnderOplaering && (
            <div style={{ background: "#FEF3C7", borderRadius: 10, padding: "11px 13px",
                          marginTop: 10, fontSize: 13, lineHeight: 1.5, color: "#92400E" }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                {lang === "da" ? "Du er med på denne opgave for at lære" : "You are on this job to learn"}
              </div>
              {lang === "da"
                ? "Registrér din tid som altid — den kommer på din lønseddel. Kunden faktureres kun for den, der udfører opgaven."
                : "Log your time as usual — it goes on your payslip. The customer is only invoiced for the person doing the job."}
            </div>
          )}

          {/* Customer + address + navigation + Nexus link */}
          {/* Nexus-knappen skal ogsaa vises paa opgaver UDEN kunde og adresse.
              Tidligere laa hele sektionen bag (kunde || adresse), hvilket skjulte
              Nexus-linket helt paa 90 ud af 723 Nexus-opgaver (fx "Soehotellet"
              og "Soeparken gennemgang", hvis skabeloner ikke har kundeoplysninger). */}
          {(t.customerName || t.address || t.contractType === "nexus") && (
            <div style={s.sheetSection}>
              <div style={s.sheetSectionTitle}><Building2 size={14} /> {tr.customer}</div>
              {t.customerName && <div style={s.sheetCustomer}>{t.customerName}</div>}
              {t.address && (
                <div style={s.sheetAddress}>
                  <MapPin size={13} color="#94A3B8" style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>{t.address}</span>
                </div>
              )}
              {mapsUrl && (
                <a href={mapsUrl} target="_blank" rel="noreferrer" style={s.navBtnLarge}>
                  <Navigation size={16} /> {tr.navigate} — Google Maps
                </a>
              )}
              {t.contractType === "nexus" && (
                <button
                  type="button"
                  style={{ ...s.navBtnLarge, background: "#4F46E5", marginTop: 8,
                           border: "none", width: "100%", font: "inherit", cursor: "pointer" }}
                  onClick={openNexusApp}>
                  🏢 {tr.openNexus}
                </button>
              )}
            </div>
          )}

          {/* Adgang. Teksten ligger ikke i appen — den hentes naar hun trykker, og hver
              aabning registreres. Derfor staar det ogsaa paa knappen: hun skal vide det
              foer hun trykker, ikke opdage det bagefter.
              Kontaktoplysningerne (telefon/kontaktperson) staar allerede paa opgaven —
              de er ikke beskyttet som noeglekoden. Men de vises foerst HER, samtidig
              med koden, saa det ene tryk daekker begge: kontoret kan se i loggen at
              hun ogsaa har set kontaktoplysningerne, ikke kun koden.
              22.9.2026: KUN paa privat/erhverv. Paa nexus/aeldrelov staar kontaktpersonen
              fra Dinero-opslaget ikke hos borgeren, men hos kommunen — det er ikke den,
              hun skal ringe til, hvis noget er anderledes ude paa besoeget, og at vise det
              her ville se ud som om det var det. */}
          <div style={s.sheetSection}>
            <div style={s.sheetSectionTitle}><Lock size={14} /> {tr.access}</div>
            {adgangTekst !== null ? (
              <>
                {(t.kontaktperson || t.telefon) && !BETALER_ER_IKKE_STEDET.includes(t.contractType) && (
                  <div style={{ ...s.sheetAccessText, marginBottom: 8 }}>
                    {t.kontaktperson && (
                      <div>{(lang === "da" ? "Kontaktperson: " : "Contact: ") + t.kontaktperson}</div>
                    )}
                    {t.telefon && (
                      <div>{(lang === "da" ? "Telefon: " : "Phone: ") + t.telefon}</div>
                    )}
                  </div>
                )}
                <div style={s.sheetAccessText}>{adgangTekst || tr.accessNone}</div>
                <div style={s.adgangLogget}>
                  {adgangFraKopi ? tr.accessFromCopy : tr.accessLogged}
                </div>
              </>
            ) : (
              <>
                <button type="button" style={s.adgangBtn} disabled={adgangHenter} onClick={hentAdgang}>
                  🔒 {adgangHenter ? tr.accessOpening : tr.accessShow}
                </button>
                <div style={s.adgangHint}>{tr.accessHint}</div>
                {adgangFejl && <div style={s.notatFejl}>{adgangFejl}</div>}
              </>
            )}
          </div>

          {/* Video */}
          {t.videoUrl && (
            <div style={s.sheetSection}>
              <a href={t.videoUrl} target="_blank" rel="noreferrer" style={s.videoBtnLarge}>
                <Video size={16} /> {tr.watchVideo}
              </a>
            </div>
          )}

          {/* Checklist */}
          {t.checklist && t.checklist.length > 0 && (
            <div style={s.sheetSection}>
              <div style={s.sheetSectionTitle}>
                <ListChecks size={14} /> {tr.tasks}
                <span style={s.progPill}>{clProg.done}/{clProg.total}</span>
              </div>
              <div style={s.checklistWrap}>
                {t.checklist.map((item) => (
                  <div key={item.id} style={s.checklistItem}>
                    <button style={s.checklistBtn} onClick={() => onToggleChecklist(t.id, item.id)}>
                      <span style={item.done ? s.cbChecked : s.cbUnchecked}>
                        {item.done && <Check size={12} color="#fff" strokeWidth={3} />}
                      </span>
                      <div style={s.checklistContent}>
                        <span style={{ ...s.checklistText, textDecoration: item.done ? "line-through" : "none", color: item.done ? "#94A3B8" : "#111111" }}>
                          {item.text}
                        </span>
                        {item.description && <div style={s.checklistDesc}>{item.description}</div>}
                      </div>
                    </button>
                    {item.videoUrl && (
                      <a href={item.videoUrl} target="_blank" rel="noreferrer" style={s.taskVideoBtn}>
                        <Video size={12} /> {tr.taskVideo}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Registreret tid staar her, men kan ikke rettes. Selve registreringen sker
              i afslutningsflowet — det er dét der holder denne skaerm ren. Visningen
              bliver dog: har man arbejdet i to omgange, skal man kunne se hvad der
              allerede er registreret, foer man afslutter igen. */}
          {totalLogged > 0 && (
            <div style={s.sheetSection}>
              <div style={s.sheetSectionTitle}><Clock size={14} /> {tr.timeTracking}</div>
              <div style={s.timeProgress}>
                <div style={s.timeBar}>
                  <div style={{ ...s.timeBarFill, width: `${Math.min(100, (myLogged / t.duration) * 100)}%` }} />
                </div>
                <div style={s.timeMeta}>
                  <span>{fmtMin(myLogged)} {tr.registered}</span>
                  <span style={{ color: "#94A3B8" }}>/ {fmtMin(t.duration)} {tr.planned}</span>
                </div>
                {totalLogged !== myLogged && (
                  <div style={s.timeMeta2}>{tr.allTeam} {fmtMin(totalLogged)} {tr.inTotal}</div>
                )}
              </div>
            </div>
          )}

          {/* Kommentar og billeder — altid tilgaengelig, ogsaa paa en opgave der gik fint.
              Ellers kunne man ikke dokumentere et beskidt koekken paa en normal opgave. */}
          {/* Kun laesning her. Nye kommentarer skrives i afslutningsflowet — men en
              note fra en kollega ("noeglen sidder stramt") er information man skal
              have FOER man gaar ind, saa de gemte noter bliver staaende. */}
          {noter.length > 0 && (
          <div style={s.sheetSection}>
            <div style={s.sheetSectionTitle}>💬 {tr.notesTitle}</div>

            {noter.map((n) => {
              const skrevetAf = n.employee_id === employee.id ? "" : " ";
              const tid = new Date(n.created_at).toLocaleString("da-DK", {
                day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
              });
              return (
                <div key={n.id} style={s.notatKort}>
                  <div style={s.notatTid}>
                    {tid}{skrevetAf}
                    {n.kind === "forgaeves" && <span style={s.notatArt}>Kom ikke ind</span>}
                  </div>
                  {n.text && <div style={s.notatTekst}>{n.text}</div>}
                  {(n.photos || []).length > 0 && (
                    <div style={s.notatFotoRaekke}>
                      {(n.photos || []).map((sti) => (
                        fotoUrls[sti]
                          ? <a key={sti} href={fotoUrls[sti]} target="_blank" rel="noreferrer">
                              <img src={fotoUrls[sti]} alt="" style={s.notatFoto} />
                            </a>
                          : <div key={sti} style={{ ...s.notatFoto, background: "#F1F5F9" }} />
                      ))}
                    </div>
                  )}
                  {n.photos_deleted_at && (
                    <div style={s.notatSlettet}>{tr.notesPhotosDeleted}</div>
                  )}
                </div>
              );
            })}
          </div>
          )}

        </div>

        {/* Fast bjaelke. Den handling der afslutter besoeget skal kunne rammes uden at
            scrolle — paa en opgave med femten tjeklistepunkter laa den foer helt nede
            under kunde, adgang, video, produkter, tid og kommentarfelt. */}
        <div style={s.afslutBund}>
          {done ? (
            <button style={s.doneActiveLarge} onClick={() => onSetStatus(task.id, false)}>
              <CheckCircle2 size={18} /> {tr.markNotDone}
            </button>
          ) : (
            <>
              <button style={s.primaerStor} onClick={() => setVisAfslut(true)}>
                {tr.finishOpen}
              </button>
              {problemSendt ? (
                <div style={s.problemSendt}>
                  ✓ {problemSendt === "forgaeves" ? tr.reportSentNoEntryShort : tr.reportSentNewTimeShort}
                </div>
              ) : (
                <button style={s.problemBtn} onClick={() => setVisProblem(true)}>
                  🚩 {tr.reportProblem}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {visAfslut && (
        <AfslutOpgave
          task={task} employee={employee} lang={lang} tr={tr} supabaseClient={supabaseClient}
          onLogMinutes={onLogMinutes} onSetStatus={onSetStatus}
          fraListe={fraListe}
          onAfbryd={() => setVisAfslut(false)}
          onFaerdig={() => { setVisAfslut(false); onClose(); }}
        />
      )}

      {visProblem && (
        <MeldProblem
          task={task} employee={employee} lang={lang} tr={tr} supabaseClient={supabaseClient}
          onAfbryd={() => setVisProblem(false)}
          onSendt={(art, nytNotat) => {
            setProblemSendt(art);
            // Notatet vises med det samme paa opgaven, saa hun kan se at billederne
            // rent faktisk kom med — og ikke sender det hele en gang mere.
            if (nytNotat) {
              setNoter((prev) => [nytNotat, ...prev]);
              if ((nytNotat.photos || []).length > 0) {
                signeredeFotoUrls(supabaseClient, nytNotat.photos).then((urls) => {
                  setFotoUrls((prev) => {
                    const kort = { ...prev };
                    nytNotat.photos.forEach((sti, i) => { if (urls[i]) kort[sti] = urls[i]; });
                    return kort;
                  });
                });
              }
            }
          }}
        />
      )}
    </div>
  );
}

// ── Hook: oversæt opgavetitel i listen ───────────────────────────────────────
function useTranslatedTitle(title, lang) {
  const [translated, setTranslated] = useState(title);
  useEffect(() => {
    if (lang === "da") { setTranslated(title); return; }
    translateText(title, lang).then(setTranslated);
  }, [title, lang]);
  return translated;
}

function TaskCard({ seg, employee, lang, onClick }) {
  const t = seg.task;
  const done = !!((t.completed_by_employee || {})[employee.id]);
  const inProgress = t.status === "i_gang";
  const myLogged = (t.timeLog || []).filter((l) => l.empId === employee.id).reduce((s, l) => s + (l.minutes || 0), 0);
  const clProg = { done: (t.checklist || []).filter((i) => i.done).length, total: (t.checklist || []).length };
  const translatedTitle = useTranslatedTitle(t.title, lang);
  const ident = opgaveIdentitet(t);
  return (
    <div style={{ ...s.taskCard, opacity: done ? 0.7 : 1 }} onClick={onClick}>
      <div style={{ ...s.taskAccent, background: done ? "#22C55E" : inProgress ? "#F59E0B" : "#D6247A" }} />
      <div style={s.taskBody}>
        <div style={s.taskTime}>{fmtClock(seg.start)}</div>
        <div style={s.taskTitle}>{translatedTitle}</div>

        {/* Hvem og hvor. Hvad der staar oeverst afgoeres af kontrakttypen —
            se opgaveIdentitet(). */}
        {ident.primaer && (
          <div style={s.taskHvor}>
            <MapPin size={14} color="#D6247A" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ minWidth: 0 }}>
              <div style={s.taskReference}>{ident.primaer}</div>
              {ident.sekundaer && <div style={s.taskAdresseTekst}>{ident.sekundaer}</div>}
            </div>
          </div>
        )}

        {/* Naviger. Ét tryk fra kortet — hun skal ikke aabne opgaven og lede foerst.
            stopPropagation, ellers aabner kortet sig bagved kortet der aabner. */}
        {ident.adresse && (
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ident.adresse)}`}
            target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            style={s.taskNavKnap}>
            <Navigation size={12} /> {lang === "da" ? "Kør derhen" : "Navigate"}
          </a>
        )}

        {/* Nederst staar den der ikke er stedet: paa kommunale opgaver kommunen der
            betaler, paa private en eventuel kontaktperson. Er der ingen, staar der
            kun maerket. */}
        {(ident.kunde || t.contractType) && (
          <div style={s.taskCustomer}>
            {ident.kunde && <Building2 size={11} color="#94A3B8" />}
            {ident.kunde && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ident.kunde}
              </span>
            )}
            {t.contractType === "nexus" && <span style={{ fontSize:9.5, fontWeight:700, color:"#4F46E5", background:"#EEF2FF", borderRadius:6, padding:"1px 5px", marginLeft:3, flexShrink:0 }}>Nexus</span>}
            {t.contractType === "privat" && <span style={{ fontSize:9.5, fontWeight:700, color:"#9C1B5D", background:"#FFF6FA", borderRadius:6, padding:"1px 5px", marginLeft:3, flexShrink:0 }}>{lang === "da" ? "Privat" : "Private"}</span>}
            {t.contractType === "aeldrelov" && <span style={{ fontSize:9.5, fontWeight:700, color:"#C2410C", background:"#FFF7ED", borderRadius:6, padding:"1px 5px", marginLeft:3, flexShrink:0 }}>Ældrelov</span>}
          </div>
        )}
        {/* Noeglen skal hentes paa kontoret. Staar paa selve kortet i dagslisten, ikke
            inde i opgaven — hun skal se det inden hun koerer, ikke naar hun staar der. */}
        {t.needsKeyPickup && (
          <div style={s.noegleMaerke}>🔑 {lang === "da" ? "Hent nøgle/adgangskort på kontoret" : "Pick up key or access card at the office"}</div>
        )}
        {(t.oplaering || []).includes(employee.id) && (
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#92400E", background: "#FEF3C7",
                        borderRadius: 8, padding: "5px 8px", marginTop: 6 }}>
            {lang === "da" ? "Du er med for at lære" : "You are here to learn"}
          </div>
        )}
        <div style={s.taskMeta}>
          <span style={s.taskDuration}>{fmtMin(t.duration)}</span>
          {clProg.total > 0 && <span style={s.taskChecklist}><ListChecks size={11} /> {clProg.done}/{clProg.total}</span>}
          {myLogged > 0 && <span style={s.taskLogged}><Clock size={11} /> {fmtMin(myLogged)}</span>}
        </div>
      </div>
      <div style={s.taskRight}>
        {done ? <CheckCircle2 size={24} color="#22C55E" /> : <ChevronRight size={20} color="#CBD5E1" />}
      </div>
    </div>
  );
}

function weekMeta(weekNo, year) {
  const jan4 = new Date(year ?? new Date().getFullYear(), 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7;
  const weekOneMonday = new Date(jan4);
  weekOneMonday.setDate(jan4.getDate() - jan4Day);
  const monday = new Date(weekOneMonday);
  monday.setDate(weekOneMonday.getDate() + (weekNo - 1) * 7);
  const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
  const fmt = (d) => d.toLocaleDateString("da-DK", { day: "numeric", month: "short" });
  return `${fmt(monday)} – ${fmt(friday)}`;
}

// Loginnet findes, men det hoerer ikke til en medarbejder. Skaermen var foer en
// blindgyde: én linje om at kontakte planlaeggeren, og en Log ud-knap.
//
// Det sker i praksis for en KUNDE. Bruger hun samme mailadresse til kundeportalen —
// eller har hun engang vaeret medarbejder — lander hun her og tror hun er lukket ude.
// Derfor slaas det op om hun er portalbruger, og saa peges der derhen.
const PORTAL_URL = "https://jammerbugtrengoering-kundeportal.netlify.app";

// ── Beskeder paa telefonen ──────────────────────────────────────────────────
//
// Web push. Ingen Firebase og ingen tredjepart: beskeden krypteres hos os og kan
// kun laeses af telefonen.
//
// PAA IPHONE VIRKER DET KUN, HVIS APPEN LIGGER PAA HJEMMESKAERMEN. En fane i Safari
// faar ingenting — Apple tillader det ikke. Derfor spoerger vi ikke om lov, foer vi
// har set at appen koerer installeret; ellers bruger medarbejderen sit ene "nej"
// paa en dialog der alligevel ikke kunne virke, og saa er den svaer at faa frem igen.
const VAPID_OFFENTLIG = "BPhgmi5n1jTwEiLyFJDPBSaVA2WgXpW3fmFM8m_r6Uy4sYCCDYImC-W0pzcEKQFfTm-c0eU-6WhWUdHnotJB1Yc";

function base64TilBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const rent = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raa = atob(rent);
  return Uint8Array.from([...raa].map((c) => c.charCodeAt(0)));
}

// Staar appen paa hjemmeskaermen? Safari svarer paa sin egen maade, derfor to tjek.
function koererInstalleret() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

function erIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// Al logik om tilladelser og abonnementer ét sted. Bruges baade af banneret paa
// dagen og af valget under profilen, saa de to aldrig kan komme til at vise
// forskellige tilstande for det samme.
//
// BESKEDER KAN IKKE VAERE SLAAET TIL SOM STANDARD. Browseren kraever et rigtigt klik
// fra brugeren, og tilladelsen skal bedes om INDE i det klik. Beder man ved
// sideindlaesning, afviser browseren det uden at vise noget - og har hun én gang
// sagt nej, skal hun ind i telefonens indstillinger for at fortryde. Den ene chance
// maa ikke braendes af paa en dialog hun ikke forventede.
//
// Det naermeste vi kommer "som standard" er de to ting nedenfor:
//   1. Har hun ALLEREDE givet tilladelse, tilmeldes telefonen af sig selv. Det
//      daekker ny telefon, ryddet browser, og alle der sagde ja engang.
//   2. Har hun aldrig taget stilling, staar der et banner paa dagen. Det forsvinder
//      for altid, saa snart hun har svaret.
// ── Indstillinger ────────────────────────────────────────────────────────────
//
// Fuld skaerm med et sort hoved og et kryds - samme form som hjaelpesiden, saa der
// er ét moenster i appen og ikke to.
//
// Den laa foer som et panel der foldede sig ud under navnet og skubbede dagen ned.
// Med sprog, dagsvisning, beskeder, adgangskode, oversaettelse og log ud i samme
// flade blev det en vaeg af knapper, hvor intet var vigtigere end noget andet.
//
// Tre ting styrer opbygningen:
//   - Én ting pr. raekke, med det valgte skrevet UNDER. Saa kan man se sin
//     indstilling uden at aabne noget og uden at tyde hvilken knap der er fremhaevet.
//   - Valg med flere muligheder aabner en underside. Alt fremme paa én gang er
//     praecis det der goer en skaerm rodet.
//   - Log ud staar alene nederst med roed kant. Det er den eneste handling med en
//     konsekvens, og den skal ikke ligge mellem sprog og adgangskode.
function Indstillinger({ employee, session, lang, setLang, dagsVisning, setDagsVisning,
                         onSignOut, onPasswordReset, resetSent, resetLoading, onLuk }) {
  const da = lang === "da";
  const [underside, setUnderside] = useState(null);   // null | "sprog" | "dag"

  const initialer = avatarTegn(employee.name, employee.id);

  const raekke = {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
    width: "100%", textAlign: "left", background: "#fff", cursor: "pointer",
    border: "1px solid #E2E8F0", borderRadius: 12, padding: "13px 14px", minHeight: 56,
  };
  const overskrift = { fontSize: 12, color: "#94A3B8", margin: "0 0 8px 2px" };
  const titel = { fontSize: 14.5, fontWeight: 600, color: "#111111" };
  const svar = { fontSize: 12.5, color: "#64748B", marginTop: 2 };

  function Valgside({ navn, punkter, valgt, vaelg }) {
    return (
      <div style={{ padding: "14px 16px calc(24px + env(safe-area-inset-bottom))" }}>
        {/* En bar tekstlink var for spinkel til at vaere vejen tilbage. Her er den
            eneste udvej fra undersiden, og saa skal den se ud som en knap. */}
        <button onClick={() => setUnderside(null)}
          style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14,
                   border: "1px solid #E2E8F0", background: "#fff", color: "#111111",
                   borderRadius: 12, padding: "12px 16px", minHeight: 48,
                   fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
          <ChevronLeft size={19} color="#D6247A" /> {da ? "Tilbage" : "Back"}
        </button>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>{navn}</div>
        {punkter.map(([k, l, forklaring]) => (
          <button key={k} onClick={() => { vaelg(k); setUnderside(null); }}
            style={{ ...raekke, marginBottom: 8,
                     border: valgt === k ? "2px solid #D6247A" : "1px solid #E2E8F0",
                     background: valgt === k ? "#FCE4EF" : "#fff" }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ ...titel, display: "block", color: valgt === k ? "#9C1B5D" : "#111111" }}>{l}</span>
              {forklaring && <span style={{ ...svar, display: "block",
                                            color: valgt === k ? "#9C1B5D" : "#64748B" }}>{forklaring}</span>}
            </span>
            {valgt === k && <Check size={19} color="#D6247A" style={{ flexShrink: 0 }} />}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#F8FAFC", zIndex: 130,
                  display: "flex", flexDirection: "column" }}>
      {/* Appen koerer med viewport-fit=cover for at fylde skaermen helt ud. Uden
          det her lagde hovedet sig ind UNDER statuslinjen paa en iPhone, saa
          klokkeslaet og batteri stod oven i navnet. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 10, background: "#111", color: "#fff",
                    padding: "calc(12px + env(safe-area-inset-top)) 14px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ width: 38, height: 38, borderRadius: "50%", background: "#D6247A",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{initialer}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: "nowrap",
                          overflow: "hidden", textOverflow: "ellipsis" }}>{medSolsikke(employee.name, employee.id)}</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>
              {da ? "Indstillinger" : "Settings"}
            </div>
          </div>
        </div>
        <button onClick={onLuk} aria-label={da ? "Luk" : "Close"}
          style={{ border: "none", background: "#333", color: "#fff", borderRadius: 10,
                   width: 38, height: 38, fontSize: 18, cursor: "pointer", flexShrink: 0 }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
        {underside === "sprog" ? (
          <Valgside navn={da ? "Sprog" : "Language"} valgt={lang} vaelg={setLang}
            punkter={[["da", "Dansk", null], ["en", "English", null]]} />
        ) : underside === "dag" ? (
          <Valgside navn={da ? "Vis dagen som" : "Show the day as"} valgt={dagsVisning} vaelg={setDagsVisning}
            punkter={[
              ["tid", da ? "Tidslinje" : "Timeline",
               da ? "Klokkeslæt ned ad siden, med kørsel imellem" : "Times down the page, with travel in between"],
              ["liste", da ? "Liste" : "List",
               da ? "Opgaverne under hinanden" : "The jobs one after another"],
            ]} />
        ) : (
          <div style={{ padding: "14px 16px calc(28px + env(safe-area-inset-bottom))" }}>
            <div style={overskrift}>{da ? "Sådan ser dagen ud" : "How the day looks"}</div>
            <button style={{ ...raekke, marginBottom: 8 }} onClick={() => setUnderside("dag")}>
              <span style={{ minWidth: 0 }}>
                <span style={{ ...titel, display: "block" }}>{da ? "Vis dagen som" : "Show the day as"}</span>
                <span style={{ ...svar, display: "block" }}>
                  {dagsVisning === "tid"
                    ? (da ? "Tidslinje med klokkeslæt" : "Timeline with times")
                    : (da ? "Liste" : "List")}
                </span>
              </span>
              <ChevronRight size={19} color="#CBD5E1" style={{ flexShrink: 0 }} />
            </button>
            <button style={{ ...raekke, marginBottom: 18 }} onClick={() => setUnderside("sprog")}>
              <span style={{ minWidth: 0 }}>
                <span style={{ ...titel, display: "block" }}>{da ? "Sprog" : "Language"}</span>
                <span style={{ ...svar, display: "block" }}>{da ? "Dansk" : "English"}</span>
              </span>
              <ChevronRight size={19} color="#CBD5E1" style={{ flexShrink: 0 }} />
            </button>

            <div style={overskrift}>{da ? "Beskeder" : "Notifications"}</div>
            <div style={{ marginBottom: 18 }}>
              <BeskedIndstilling lang={lang} employee={employee} />
            </div>

            <div style={overskrift}>{da ? "Din adgang" : "Your access"}</div>
            {resetSent ? (
              <div style={{ background: "#ECFDF5", border: "1px solid #A7F3D0", borderRadius: 12,
                            padding: "13px 14px", fontSize: 13, color: "#166534", lineHeight: 1.55,
                            marginBottom: 18 }}>
                ✓ {da ? "Vi har sendt et link til" : "We sent a link to"} {session?.user?.email}
              </div>
            ) : (
              <button style={{ ...raekke, marginBottom: 18, display: "block" }}
                onClick={onPasswordReset} disabled={resetLoading}>
                <span style={{ ...titel, display: "block" }}>
                  {resetLoading ? (da ? "Sender…" : "Sending…") : (da ? "Skift adgangskode" : "Change password")}
                </span>
                <span style={{ ...svar, display: "block" }}>
                  {da ? "Vi sender et link til " : "We send a link to "}{session?.user?.email}
                </span>
              </button>
            )}

            <button onClick={onSignOut}
              style={{ width: "100%", padding: "14px 0", borderRadius: 12, minHeight: 52,
                       border: "1px solid #FCA5A5", background: "#fff", color: "#DC2626",
                       fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
              {da ? "Log ud" : "Sign out"}
            </button>

            {/* Krydset i hjoernet er lille og sidder oppe i et hjoerne. Den her er
                for dem der scroller til bunden og leder efter vejen ud. */}
            <button onClick={onLuk}
              style={{ width: "100%", padding: "14px 0", borderRadius: 12, minHeight: 52,
                       marginTop: 10, border: "none", background: "#111", color: "#fff",
                       fontWeight: 700, fontSize: 15, cursor: "pointer" }}>
              {da ? "Luk indstillinger" : "Close settings"}
            </button>

            <div style={{ textAlign: "center", fontSize: 11, color: "#CBD5E1", marginTop: 16 }}>
              Worklist · {typeof __BYGGET__ === "string" ? __BYGGET__ : "?"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function useBeskeder(employee) {
  const [status, setStatus] = useState("henter");   // henter | fra | til | ikke_muligt | skal_installeres
  const [arbejder, setArbejder] = useState(false);
  const [fejl, setFejl] = useState("");

  const tilmeld = useCallback(async (reg) => {
    const abon = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64TilBytes(VAPID_OFFENTLIG),
    });
    const j = abon.toJSON();
    // Endpoint er noeglen. Tilmelder hun sig igen paa samme telefon, opdateres
    // raekken i stedet for at der laegges en ny - ellers ville hun faa dobbelt op.
    const { error } = await supabase.from("push_abonnementer").upsert({
      endpoint: abon.endpoint,
      employee_id: employee.id,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      enhed: navigator.userAgent.slice(0, 200),
    }, { onConflict: "endpoint" });
    if (error) throw error;
  }, [employee?.id]);

  useEffect(() => {
    let afbrudt = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!afbrudt) setStatus("ikke_muligt");
        return;
      }
      // iPhone uden hjemmeskaerm: dialogen ville fejle, saa vi viser vejledningen
      // i stedet for en knap der ikke kan holde hvad den lover.
      if (erIOS() && !koererInstalleret()) {
        if (!afbrudt) setStatus("skal_installeres");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const abon = await reg.pushManager.getSubscription();
        if (Notification.permission === "granted") {
          // Tilladelsen er der. Mangler abonnementet - ny telefon, ryddet browser -
          // oprettes det uden at spoerge. Der er ikke noget at spoerge om; hun har
          // allerede sagt ja.
          if (!abon) { try { await tilmeld(reg); } catch { /* proeves igen naeste gang */ } }
          if (!afbrudt) setStatus("til");
          return;
        }
        if (!afbrudt) setStatus(abon ? "til" : "fra");
      } catch {
        if (!afbrudt) setStatus("ikke_muligt");
      }
    })();
    return () => { afbrudt = true; };
  }, [tilmeld]);

  async function slaaTil() {
    setArbejder(true); setFejl("");
    try {
      // Tilladelsen SKAL bedes om inde i et klik.
      const lov = await Notification.requestPermission();
      if (lov !== "granted") {
        setFejl("nej");
        setArbejder(false);
        return;
      }
      await tilmeld(await navigator.serviceWorker.ready);
      setStatus("til");
    } catch (e) {
      setFejl(String(e?.message || e));
    }
    setArbejder(false);
  }

  async function slaaFra() {
    setArbejder(true); setFejl("");
    try {
      const reg = await navigator.serviceWorker.ready;
      const abon = await reg.pushManager.getSubscription();
      if (abon) {
        await supabase.from("push_abonnementer").delete().eq("endpoint", abon.endpoint);
        await abon.unsubscribe();
      }
      setStatus("fra");
    } catch (e) {
      setFejl(String(e?.message || e));
    }
    setArbejder(false);
  }

  return { status, arbejder, fejl, slaaTil, slaaFra };
}

// Banneret paa dagen. Staar KUN saa laenge hun aldrig har taget stilling, og
// forsvinder for altid naar hun har svaret - ogsaa hvis svaret er nej.
function BeskedBanner({ lang, employee }) {
  const { status, arbejder, fejl, slaaTil } = useBeskeder(employee);
  const da = lang === "da";
  if (status !== "fra") return null;

  return (
    <div style={{ background: "#FCE4EF", border: "1.5px solid #F0A9C8", borderRadius: 12,
                  padding: "12px 14px", marginBottom: 12 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "#9C1B5D", marginBottom: 2 }}>
        🔔 {da ? "Få besked på telefonen" : "Get notified on your phone"}
      </div>
      <div style={{ fontSize: 12.5, color: "#9C1B5D", lineHeight: 1.5, marginBottom: 10 }}>
        {da ? "Når din plan ændres, når kontoret svarer, og hvis du mangler at registrere tid."
            : "When your schedule changes, when the office replies, and if time entries are missing."}
      </div>
      <button onClick={slaaTil} disabled={arbejder}
        style={{ width: "100%", padding: "11px 0", borderRadius: 10, border: "none",
                 background: "#D6247A", color: "#fff", fontWeight: 700, fontSize: 14,
                 cursor: "pointer", minHeight: 44 }}>
        {arbejder ? "…" : (da ? "Slå beskeder til" : "Turn on notifications")}
      </button>
      {fejl === "nej" && (
        <div style={{ fontSize: 11.5, color: "#B91C1C", marginTop: 8, lineHeight: 1.5 }}>
          {da ? "Du sagde nej. Vil du fortryde, skal det ske i telefonens indstillinger for Worklist."
              : "You declined. To change it, use your phone settings for Worklist."}
        </div>
      )}
    </div>
  );
}

// Beskeder som en raekke med kontakt. En knap der skiftevis siger "Slå til" og
// "Slå fra" kraever at man laeser knappen for at vide hvad tilstanden ER. En kontakt
// viser tilstanden, og teksten under siger hvad man faar ud af den.
function BeskedIndstilling({ lang, employee }) {
  const { status, arbejder, fejl, slaaTil, slaaFra } = useBeskeder(employee);
  const da = lang === "da";
  const til = status === "til";

  const kort = {
    background: "#fff", border: "1px solid #E2E8F0", borderRadius: 12, padding: "13px 14px",
  };

  if (status === "henter") {
    return <div style={{ ...kort, fontSize: 13, color: "#94A3B8" }}>{da ? "Et øjeblik…" : "One moment…"}</div>;
  }

  // Paa iPhone uden hjemmeskaerm ville en kontakt love noget den ikke kan holde.
  // Der staar vejledningen i stedet.
  if (status === "skal_installeres") {
    return (
      <div style={{ ...kort, borderColor: "#FDE68A", background: "#FFFBEB" }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: "#92400E", marginBottom: 4 }}>
          {da ? "Beskeder på telefonen" : "Notifications"}
        </div>
        <div style={{ fontSize: 12.5, color: "#92400E", lineHeight: 1.55 }}>
          {da
            ? "På iPhone skal appen ligge på hjemmeskærmen først. Tryk på Del-knappen nederst i Safari, vælg «Føj til hjemmeskærm», og åbn Worklist derfra."
            : "On iPhone the app must be on your home screen first. Tap Share in Safari, choose “Add to Home Screen”, and open Worklist from there."}
        </div>
      </div>
    );
  }

  if (status === "ikke_muligt") {
    return (
      <div style={kort}>
        <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 4 }}>
          {da ? "Beskeder på telefonen" : "Notifications"}
        </div>
        <div style={{ fontSize: 12.5, color: "#94A3B8", lineHeight: 1.55 }}>
          {da ? "Denne telefon kan ikke give beskeder fra appen. Du får dem stadig på mail."
              : "This phone cannot show notifications. You will still get emails."}
        </div>
      </div>
    );
  }

  return (
    <div style={kort}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: "#111111" }}>
            {da ? "Beskeder på telefonen" : "Notifications"}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 2, color: til ? "#16A34A" : "#94A3B8" }}>
            {til ? (da ? "Slået til på denne telefon" : "On for this phone")
                 : (da ? "Slået fra" : "Off")}
          </div>
        </div>
        <button role="switch" aria-checked={til} disabled={arbejder}
          aria-label={da ? "Beskeder på telefonen" : "Notifications"}
          onClick={() => (til ? slaaFra() : slaaTil())}
          style={{ width: 50, height: 30, borderRadius: 999, border: "none", flexShrink: 0,
                   background: til ? "#16A34A" : "#CBD5E1", position: "relative",
                   cursor: "pointer", opacity: arbejder ? 0.6 : 1, padding: 0 }}>
          <span style={{ position: "absolute", top: 3, left: til ? 23 : 3, width: 24, height: 24,
                         borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.55, marginTop: 9,
                    paddingTop: 9, borderTop: "1px solid #F1F5F9" }}>
        {da ? "Du får besked, når din plan ændres, når kontoret svarer dig, og hvis du mangler at registrere tid."
            : "You are notified when your schedule changes, when the office replies, and if time entries are missing."}
      </div>
      {fejl === "nej" && (
        <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 8, lineHeight: 1.5 }}>
          {da ? "Du sagde nej. Vil du fortryde, skal det ske i telefonens indstillinger for Worklist."
              : "You declined. To change it, use your phone settings for Worklist."}
        </div>
      )}
      {fejl && fejl !== "nej" && (
        <div style={{ fontSize: 12, color: "#B91C1C", marginTop: 8 }}>{fejl}</div>
      )}
    </div>
  );
}

function IngenProfil({ s, tr, onSignOut }) {
  const [portal, setPortal] = useState(undefined);   // undefined = ved det ikke endnu

  useEffect(() => {
    let afbrudt = false;
    (async () => {
      const { data } = await supabase.rpc("hent_portal_mig");
      if (!afbrudt) setPortal(data?.[0] ?? null);
    })();
    return () => { afbrudt = true; };
  }, []);

  if (portal === undefined) return (
    <div style={s.loginWrap}><div style={s.loginCard}>
      <div style={{ textAlign: "center", color: "#94A3B8", fontSize: 14 }}>Et øjeblik…</div>
    </div></div>
  );

  if (portal) return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Du skal et andet sted hen</div>
        <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.6, marginBottom: 16 }}>
          Det her er appen for vores medarbejdere. Din adgang hører til kundeportalen
          for <strong>{portal.visningsnavn}</strong>, hvor du kan se jeres opgaver og fakturaer.
        </div>
        <a href={PORTAL_URL} style={{ ...s.loginBtn, display: "block", textAlign: "center",
                                      textDecoration: "none", boxSizing: "border-box" }}>
          Åbn kundeportalen
        </a>
        <button style={{ ...s.loginBtn, background: "transparent", color: "#64748B", marginTop: 8 }}
          onClick={onSignOut}>{tr.signOut}</button>
      </div>
    </div>
  );

  return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={s.errorBox}>{tr.noProfileError}</div>
        <button style={s.loginBtn} onClick={onSignOut}>{tr.signOut}</button>
      </div>
    </div>
  );
}

export default function MedarbejderApp() {
  // Sproget foelger TELEFONEN, indtil hun selv vaelger noget andet.
  //
  // Appen taler dansk og engelsk. Er telefonen sat til dansk, faar hun dansk; er den
  // sat til hvad som helst andet — engelsk, russisk, ukrainsk — faar hun engelsk. Vi
  // oversaetter ikke til de sprog, og engelsk er naermere end dansk for den der ikke
  // kan nogen af delene.
  //
  // Raekkefoelgen er vigtig:
  //   1. localStorage — hun har valgt paa DENNE telefon
  //   2. telefonens sprog
  // Databasens default_lang laeses foerst naar profilen er hentet, og KUN hvis hun
  // faktisk har valgt (lang_valgt). Alle tyve staar med 'da' uden at have valgt det,
  // saa uden det forbehold ville feltet overtrumfe telefonen for alle.
  //
  // Beregnes synkront ved foerste render. Gjorde vi det bagefter, ville appen naa at
  // blinke paa det forkerte sprog.
  const [lang, setLang] = useState(() => {
    const gemt = localStorage.getItem("wl_lang");
    if (gemt === "da" || gemt === "en") return gemt;
    const fraTelefon = (navigator.languages?.[0] || navigator.language || "").toLowerCase();
    return fraTelefon.startsWith("da") ? "da" : "en";
  });
  const tr = T[lang];

  useEffect(() => { localStorage.setItem("wl_lang", lang); }, [lang]);

  // ── Ny version af appen ────────────────────────────────────────────────────
  // Med en service worker koerer telefonen paa en GEMT kopi af appen. Det er hele
  // pointen — den skal kunne aabnes uden daekning — men det betyder ogsaa at en
  // rettelse ikke laengere naar frem af sig selv. Foer sagde vi "hent siden med ?v=
  // bagpaa"; den vej findes ikke mere.
  //
  // Derfor: ny version hentes i baggrunden, og hun faar en besked. Den opdaterer sig
  // IKKE selv — en app der genindlaeser midt i en tidsregistrering kan smide det
  // indtastede paa gulvet.
  const [nyVersion, setNyVersion] = useState(null);

  useEffect(() => {
    let opdater;
    // Intervallet skal kunne stoppes igen. Det levede foer resten af appens levetid
    // uden nogen at rydde op efter sig — i praksis harmloest, fordi komponenten
    // aldrig forsvinder, men i udviklingstilstand koerer effekten to gange, og saa
    // laa der to timere og tjekkede det samme.
    let urSW;
    (async () => {
      try {
        const { registerSW } = await import("virtual:pwa-register");
        opdater = registerSW({
          onNeedRefresh() { setNyVersion(() => opdater); },
          onRegisteredSW(_url, reg) {
            // Tjek en gang i timen. En telefon der ligger aaben hele dagen ville ellers
            // foerst opdage en rettelse naeste gang appen blev lukket helt ned.
            if (reg) urSW = setInterval(() => reg.update(), 60 * 60 * 1000);
          },
        });
      } catch {
        // I udviklingstilstand findes modulet ikke. Det er i orden — saa er der ingen
        // service worker, og appen henter alt friskt hver gang.
      }
    })();
    return () => { if (urSW) clearInterval(urSW); };
  }, []);

  // Gemmer sprogvalget paa medarbejderen. lang_valgt saettes samtidig: derefter
  // foelger valget hende til en ny telefon i stedet for at telefonens sprog vinder.
  async function changeLang(newLang) {
    setLang(newLang);
    if (employee) {
      await supabase.from("employees")
        .update({ default_lang: newLang, lang_valgt: true }).eq("id", employee.id);
    }
  }

  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Saettes naar profilopslaget fejler paa grund af manglende forbindelse — ikke
  // fordi profilen mangler. De to skal se helt forskellige ud for medarbejderen.
  const [ingenForbindelse, setIngenForbindelse] = useState(false);
  // Tidspunktet paa den gemte kopi vi ser paa. null betyder at data er friske.
  const [kopiHentet, setKopiHentet] = useState(null);
  // Antal skrivninger der venter paa daekning. 0 = alt er sendt.
  const [koeAntal, setKoeAntal] = useState(0);
  const [koeSender, setKoeSender] = useState(false);
  const senderRef = useRef(false);
  // Sand naar den naeste genhentning skal ske uden at bytte skaermen ud.
  const stilleGenhentRef = useRef(false);
  // Taelles op naar koeen er toemt, saa dagen hentes forfra fra databasen.
  const [genhent, setGenhent] = useState(0);
  const [henterAdgang, setHenterAdgang] = useState(false);
  const [adgangHentetNu, setAdgangHentetNu] = useState(false);
  const [employee, setEmployee] = useState(null);
  const [instances, setInstances] = useState([]);
  const [travelSettings, setTravelSettings] = useState({ defaultMinutes: 20, dayStart: "07:00", overrides: {} });
  const [dataLoading, setDataLoading] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  // Planlæggeren kan kigge med i en kollegas uge for at hjælpe over telefonen.
  // viewEmpId er null når man ser sin egen plan — man starter altid hos sig selv.
  const [viewEmpId, setViewEmpId] = useState(null);
  const [allEmployees, setAllEmployees] = useState([]);
  const viewingOther = !!(viewEmpId && employee && viewEmpId !== employee.id);
  const viewedEmployee = viewingOther ? allEmployees.find((e) => e.id === viewEmpId) : null;
  const [day, setDay] = useState(todayWorkdayKey());
  // Standarddagen falder tilbage til nærmeste hverdag, så man ikke lander på en tom
  // lørdag. Men har medarbejderen faktisk opgaver i dag, og det ER weekend, skal vi
  // åbne på den rigtige dag — ellers viste appen fredag til en der møder om lørdagen.
  const weekendJumpDone = useRef(false);
  const [openTask, setOpenTask] = useState(null);
  // Tidslinje som udgangspunkt. Det er den visning der ligner en arbejdsdag, og den
  // fortaeller baade raekkefoelge og hvor lang tid der er imellem. Listen er for dem
  // der hellere vil have det som en huskeseddel — valget staar under profilen og
  // ikke paa selve dagen, hvor to knapper aad plads fra det man er kommet for.
  const [dagsVisning, setDagsVisning] = useState(() => localStorage.getItem("wl_dagsvisning") || "tid");
  useEffect(() => { localStorage.setItem("wl_dagsvisning", dagsVisning); }, [dagsVisning]);
  // Kun planlaeggere ser knappen. Databasen afviser kaldet uanset hvad, hvis den
  // der spoerger ikke er administrator — reglen ligger ikke i en skjult knap.
  const [nytMoede, setNytMoede] = useState(false);

  useEffect(() => {
    if (weekendJumpDone.current || weekOffset !== 0 || !instances.length) return;
    const tk = todayKey();
    if (tk !== "Sat" && tk !== "Sun") return;
    weekendJumpDone.current = true;
    if (instances.some((t) => t.day === tk)) setDay(tk);
  }, [instances, weekOffset]);
  const [showProfile, setShowProfile] = useState(false);
  const [showShop, setShowShop] = useState(false);
  const [showKm, setShowKm] = useState(false);
  // Det hun mangler — paa tvaers af ALLE uger, ikke kun den hun kigger paa.
  const [visMangler, setVisMangler] = useState(false);
  const [mangler, setMangler] = useState([]);
  const [manglerHenter, setManglerHenter] = useState(true);
  const [manglerFejl, setManglerFejl] = useState("");
  // Trykker hun paa en opgave fra en anden uge, skal planen foerst hente den uge.
  // Opgaven parkeres her — id OG uge — og aabnes naar netop den uge er hjemme.
  const [aabnNaarKlar, setAabnNaarKlar] = useState(null);
  // Den uge der rent faktisk ligger i instances lige nu. Se kommentaren ved
  // setIndlaestUge i hentningen: weekOffset skifter foer dataene er byttet ud.
  const [indlaestUge, setIndlaestUge] = useState(null);
  // Kom den aabne opgave fra manglelisten? Saa er listen det sted, hun arbejder FRA,
  // og der skal hun tilbage til — ogsaa hvis hun fortryder og vil tage en anden
  // foerst. Uden det blev hun efterladt i en uge, hun ikke selv havde valgt, og
  // skulle finde udraabstegnet frem igen for hver eneste opgave.
  const [fraManglelisten, setFraManglelisten] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Første gang appen åbnes på DEN her telefon. Startværdien læses én gang, så
  // introduktionen ikke kan nå at blinke forbi for en, der har set den før.
  const [visVelkomst, setVisVelkomst] = useState(() => !velkomstErSet());
  const [resetSent, setResetSent] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
    const [recoveryError, setRecoveryError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [showWeekend, setShowWeekend] = useState(false);

  const [recoveryToken, setRecoveryToken] = useState(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  async function sendPasswordReset() {
    if (!session?.user?.email) return;
    setResetLoading(true);
    await supabase.auth.resetPasswordForEmail(session.user.email, {
      redirectTo: window.location.origin + "/",
    });
    setResetLoading(false);
    setResetSent(true);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setAuthLoading(false); });
    // Supabase fornyer tokenet med jaevne mellemrum og melder tilbage her — og paa iOS
    // sker det ogsaa hver gang appen kort mister fokus, hvilket diktering goer.
    //
    // Hver melding kom med et NYT session-objekt. Satte vi det i tilstanden hver gang,
    // fik indlaesningen nedenfor en ny afhaengighed og hentede dagen forfra midt i at
    // hun sad og skrev — og alt uddgemt indhold forsvandt. Vi skifter derfor kun naar
    // det faktisk er en anden bruger, eller naar hun logger ud.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, ny) => {
      setSession((gammel) => {
        if (gammel?.user?.id && ny?.user?.id && gammel.user.id === ny.user.id) return gammel;
        return ny;
      });
      setAuthLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

useEffect(() => {
    if (window.location.hash.includes("type=recovery")) { setPasswordRecovery(true); return; }
    const params = new URLSearchParams(window.location.search);
      const tokenHash = params.get("token_hash");
      const type = params.get("type");
      if (tokenHash && type === "recovery") { setRecoveryToken(tokenHash); }
}, []);

    async function confirmRecovery() {
          if (!recoveryToken) return;
          setRecoveryLoading(true);
          const { error } = await supabase.auth.verifyOtp({ token_hash: recoveryToken, type: "recovery" });
          setRecoveryLoading(false);
          window.history.replaceState(null, "", window.location.pathname);
          setRecoveryToken(null);
          if (error) setRecoveryError("Nulstillingslinket er udløbet eller allerede brugt. Bed om et nyt.");
          else setPasswordRecovery(true);
    }

  async function opdaterKoeAntal() {
    setKoeAntal((await koeAlle()).length);
  }

  async function sendKoe() {
    // En ref og ikke tilstanden. sendKoe fanges i en lukning naar effekten nedenfor
    // saettes op, og dér er koeSender altid falsk — vagten ville aldrig udloese, og
    // to afsendelser kunne koere oven i hinanden. Databasens gentagelsesvagt ville
    // fange det, men vi skal ikke laene os op ad den for noget vi selv kan undgaa.
    if (senderRef.current) return;

    // Er koeen tom, er der ingenting at goere. Uden det her tjek koerte funktionen
    // hvert minut, fandt nul poster, konkluderede "alt er sendt" og hentede dagen
    // forfra — midt i at hun sad og dikterede et referat, som saa forsvandt.
    const foer = (await koeAlle()).length;
    if (foer === 0) { setKoeAntal(0); return; }

    senderRef.current = true;
    setKoeSender(true);
    const tilbage = await toemKoe(supabase, employee?.id);
    setKoeAntal(tilbage);
    senderRef.current = false;
    setKoeSender(false);
    // Er alt kommet af sted, hentes dagen forfra. Ellers ville hun se sine egne
    // lokale tal i stedet for det databasen faktisk endte med.
    if (tilbage === 0) {
      stilleGenhentRef.current = true;
      setGenhent((n) => n + 1);
    }
  }

  // Der findes INGEN baggrundssynkronisering paa iOS. Koeen kan kun toemmes mens appen
  // er aaben, og derfor proeves der tre steder: ved opstart, naar telefonen melder
  // forbindelse, og en gang i minuttet mens appen er fremme. Lukker hun appen i en
  // kaelder, sendes der foerst naeste gang hun aabner den — det staar i hjaelpen.
  useEffect(() => {
    if (!session) return;
    opdaterKoeAntal();
    function paaNet() { sendKoe(); }
    function paaKoe() { opdaterKoeAntal(); }
    window.addEventListener("wl-koe-aendret", paaKoe);
    window.addEventListener("online", paaNet);
    const ur = setInterval(() => { if (navigator.onLine) sendKoe(); }, 60 * 1000);
    // Naar appen kommer frem igen efter at have ligget i baggrunden — det er dét der
    // sker naar hun tager telefonen op af lommen ude hos naeste kunde.
    function paaSynlig() { if (document.visibilityState === "visible" && navigator.onLine) sendKoe(); }
    document.addEventListener("visibilitychange", paaSynlig);
    sendKoe();
    return () => {
      window.removeEventListener("wl-koe-aendret", paaKoe);
      window.removeEventListener("online", paaNet);
      document.removeEventListener("visibilitychange", paaSynlig);
      clearInterval(ur);
    };
  }, [session?.user?.id]);

  // Kommer daekningen tilbage, henter appen selv. Hun skal ikke gaette sig til at
  // trykke paa noget — hun staar formentlig midt i et arbejde med handsker paa.
  useEffect(() => {
    if (!ingenForbindelse) return;
    function paaIgen() { window.location.reload(); }
    window.addEventListener("online", paaIgen);
    return () => window.removeEventListener("online", paaIgen);
  }, [ingenForbindelse]);

  useEffect(() => {
    if (!session) return;
    async function load() {
      // En genhentning efter at koeen er toemt skal ske STILLE. Saetter vi dataLoading,
      // bytter appen hele skaermen ud med "Henter opgaver…", og alt hvad der stod i en
      // aaben tilbudsskaerm eller et halvt udfyldt afslutningsflow er vaek.
      const stille = stilleGenhentRef.current;
      stilleGenhentRef.current = false;
      if (!stille) setDataLoading(true);
      setIngenForbindelse(false);
      // error maa IKKE smides vaek her. Uden daekning kommer der ingen raekke tilbage,
      // og saa saa medarbejderen "Din bruger er ikke koblet til en medarbejder-profil"
      // — altsaa at hendes konto var vaek. Hun ville ringe til kontoret over noget der
      // bare var et hul i daekningen.
      const { data: empData, error: empFejl } = await supabase
        .from("employees").select("*").eq("auth_user_id", session.user.id).maybeSingle();

      if (empFejl || (!empData && !navigator.onLine)) {
        // Foer vi giver op: er der en gemt kopi af ugen? Saa er dagslisten stadig
        // brugbar — hun kan se hvor hun skal hen, hvad der skal laves, og hvornaar.
        const { week: u, year: a } = weekInfoWithOffset(weekOffset);
        const gemtEmp = localStorage.getItem("wl_sidste_emp");
        const kopi = gemtEmp ? laesKopi(gemtEmp, a, u) : null;
        if (kopi) {
          setEmployee(kopi.employee);
          setInstances(kopi.instances || []);
          setIndlaestUge({ aar: a, uge: u });
          if (kopi.travelSettings) setTravelSettings(kopi.travelSettings);
          setKopiHentet(kopi.hentet);
          setDataLoading(false);
          return;
        }
        setIngenForbindelse(true);
        setDataLoading(false);
        return;
      }
      // Paaskeaegget: se medSolsikke().
      saetSolsikkeSeer(empData?.is_admin);
      if (!empData) { setDataLoading(false); return; }
      setKopiHentet(null);
      // Hvem der sidst var logget ind. Uden den kan vi ikke finde den rigtige kopi
      // frem naar opslaget i employees er det foerste der fejler.
      try { localStorage.setItem("wl_sidste_emp", empData.id); } catch { /* fuldt lager */ }
      // Hjemmeadresse og transportordning ligger i sin egen tabel, hvor politikken kun
      // slipper hendes EGEN raekke igennem. Kollegernes privatadresser kan appen altsaa
      // ikke naa, uanset hvad man spoerger om.
      const { data: homeData } = await supabase
        .from("employee_home").select("home_address, travel_in_worktime")
        .eq("employee_id", empData.id).maybeSingle();
      setEmployee({
        ...empData,
        home_address: homeData?.home_address ?? null,
        travel_in_worktime: homeData?.travel_in_worktime ?? false,
      });
      // Medarbejderlisten hentes kun til administratorer, og kun paa computer.
      // Databasen har i forvejen sidste ord: en almindelig medarbejder kan slet
      // ikke laese andres opgaver, uanset hvad brugerfladen viser.
      if (empData.is_admin && isDesktopBrowser()) {
        const { data: emps } = await supabase.from("employees").select("id,name,color").order("name");
        setAllEmployees(emps || []);
      } else {
        setAllEmployees([]);
        setViewEmpId(null);
      }

      // Hendes eget valg, hvis hun har taget stilling. Har hun ikke, bliver
      // telefonens sprog staaende — feltet siger 'da' paa alle, ogsaa dem der aldrig
      // har aabnet appen, og det maa ikke laeses som et valg.
      if (empData.lang_valgt && empData.default_lang && empData.default_lang !== lang) {
        setLang(empData.default_lang);
        localStorage.setItem("wl_lang", empData.default_lang);
      }

      const { week: targetWeek, year: targetYear } = weekInfoWithOffset(weekOffset);
      const { data: instData, error: instErr } = await supabase
        // Slettemarkerede opgaver (fra en aftale der er sat som udgaaet) hentes ikke,
        // saa de forsvinder fra medarbejderens liste med det samme.
        .from("instances").select("*").eq("week", targetWeek).eq("year", targetYear).is("deleted_at", null);
      // Profilen kan sagtens komme igennem paa en doeende forbindelse mens opgaverne
      // ikke naar frem. Uden det her ville hun se en tom dag og tro at der ingen
      // opgaver var — vaerre end at se gaarsdagens liste med et tydeligt maerkat.
      if (instErr) {
        console.error("load instances error:", instErr.message);
        const kopi = laesKopi(empData.id, targetYear, targetWeek);
        if (kopi?.instances?.length) {
          setInstances(kopi.instances);
          if (kopi.travelSettings) setTravelSettings(kopi.travelSettings);
          setKopiHentet(kopi.hentet);
          setDataLoading(false);
          return;
        }
      }
      // customers-tabellen hentes IKKE laengere. Opslaget skete paa i.customer_id, og det
      // felt er null paa samtlige opgaver — kunden staar som almindelig tekst direkte paa
      // opgaven. Forespoergslen hentede altsaa hele kundelisten ned paa hver telefon og
      // brugte den aldrig. Politikken paa customers er samtidig strammet, saa den kun
      // slipper medarbejdere igennem.
      const myInstances = (instData || [])
        .filter((i) => {
          const arr = typeof i.assignees === "string" ? JSON.parse(i.assignees) : (i.assignees || []);
          return arr.includes(viewEmpId || empData.id);
        })
        .map((i) => {
          return {
            ...i,
            timeLog: i.time_log ?? [],
            requiredSkills: i.required_skills ?? [],
            // Hvem der er med paa DENNE opgave for at laere. Sat af kontoret pr.
            // opgave — hun kan sagtens vaere fast paa sine egne opgaver samme uge.
            oplaering: i.oplaering_medarbejdere ?? [],
            // Fordelingen af timer mellem dem der er paa. Tom = alle bruger duration.
            tidFordeling: i.tid_fordeling ?? {},
            customerName: i.customer_name || "",
            address: i.address_text || "",
            // Referencen. Paa kommunale opgaver staar BORGERENS navn her, mens
            // customer_name er kommunen der faar regningen. Det er borgeren og
            // adressen medarbejderen skal bruge — kommunen er kun bogholderi.
            reference: i.po_number || "",
            // accessInstructions hentes IKKE med her laengere. Kolonnen staar tom, og
            // teksten ligger i en tabel appen ikke kan laese. Den hentes kun naar
            // medarbejderen selv trykker, gennem hent_adgangsinfo, som logger opslaget.
            //
            // Knappen vises paa alle opgaver, ogsaa dem uden adgangsoplysninger. Et
            // "der er noget at hente"-flag ville kraeve en kolonne der siger noget om
            // indholdet, og saa var vi tilbage ved at afsloere noget. Er der ingenting,
            // siger svaret det — og opslaget staar i loggen, hvilket er helt i orden.
            needsKeyPickup: i.needs_key_pickup ?? false,
            contractType: i.contract_type || i.contractType || "privat",
          };
        });

      setInstances(myInstances);
      // Hvilken uge staar der faktisk i instances nu?
      //
      // weekOffset kan ikke bruges til det: den skifter med det samme, mens
      // hentningen tager tid, saa i det oejeblik peger de to hver sin vej. Det var
      // praecis dét, der fik «aabn opgaven fra manglelisten» til at give op og bare
      // vise ugeoversigten — den ledte efter opgaven i den GAMLE uges data.
      setIndlaestUge({ aar: targetYear, uge: targetWeek });

      const { data: travel } = await supabase.from("travel_settings").select("*").eq("id", "default").single();
      const { data: overrides } = await supabase.from("travel_overrides").select("*");
      let rejse = null;
      if (travel) {
        rejse = {
          defaultMinutes: travel.default_minutes,
          dayStart: travel.day_start,
          overrides: Object.fromEntries((overrides || []).map((o) => [travelKey(o.addr_a, o.addr_b), o.minutes])),
        };
        setTravelSettings(rejse);
      }

      // Gem kopien til sidst, saa den kun indeholder en hel og sammenhaengende uge.
      // Kigger man paa en kollegas plan (viewEmpId), gemmes der ikke — det er ikke
      // hendes egen dag, og den skal ikke dukke op naeste gang telefonen er offline.
      if (!viewEmpId) {
        gemKopi(empData.id, targetYear, targetWeek, {
          employee: {
            ...empData,
            home_address: homeData?.home_address ?? null,
            travel_in_worktime: homeData?.travel_in_worktime ?? false,
          },
          instances: myInstances,
          travelSettings: rejse,
        });
      }
      setDataLoading(false);
    }
    load();
  }, [session?.user?.id, weekOffset, viewEmpId, genhent]);

  useEffect(() => {
    if (openTask) {
      const updated = instances.find((t) => t.id === openTask.id);
      if (updated) setOpenTask(updated);
    }
  }, [instances]);

  // Hent «det du mangler» paa tvaers af alle uger.
  //
  // Den haenger paa instances og ikke paa genhent. genhent taelles kun op naar
  // skrivekoeen er toemt, altsaa efter en tur uden daekning — men instances skiftes
  // hver gang der registreres tid eller afsluttes en opgave. Saa falder opgaven af
  // listen i samme oejeblik hun er faerdig med den, og tallet paa udraabstegnet
  // taeller ned mens hun arbejder. Et tal, der bliver staaende efter man har gjort
  // arbejdet, er vaerre end intet tal.
  //
  // Opslaget FOELGER «Se plan for». Det er ikke pynt: foerste udgave gemte bare
  // ikonet, naar kontoret kiggede paa en kollega — for ellers stod planlaeggerens
  // eget tal over hendes plan. Men saa kunne kontoret ikke se, hvad hun manglede,
  // netop naar de havde hende i roeret, og det er dér, spoergsmaalet stilles.
  //
  // Vagten ligger i databasen: kun en administrator kan pege paa en anden. Sender en
  // almindelig medarbejder et id ind, faar hun stille og roligt sine egne.
  useEffect(() => {
    if (!session?.user?.id) return;
    let afbrudt = false;
    (async () => {
      setManglerHenter(true); setManglerFejl("");
      const { data, error } = await supabase.rpc("mine_manglende",
        { p_emp: viewingOther ? viewEmpId : null });
      if (afbrudt) return;
      if (error) { setManglerFejl(error.message); setMangler([]); }
      else setMangler(data || []);
      setManglerHenter(false);
    })();
    return () => { afbrudt = true; };
  }, [session?.user?.id, instances, viewingOther, viewEmpId]);

  // Den rigtige uge er hentet — nu kan den opgave, hun trykkede paa, aabnes.
  //
  // Der ventes paa indlaestUge og ikke paa dataLoading. Da det var dataLoading, kom
  // effekten til at koere i det oejeblik, hvor weekOffset allerede var skiftet, mens
  // instances endnu var den gamle uge og hentningen ikke var naaet at melde sig i
  // gang. Saa blev opgaven ikke fundet, oensket blev ryddet, og hun endte paa
  // ugeoversigten i stedet for inde i opgaven. Det virkede paa telefonen og faldt i
  // browseren — forskellen var alene, hvor hurtigt svaret kom.
  //
  // Findes opgaven ikke i den uge, den hoerer til, ryddes oensket alligevel: saa er
  // den fjernet af kontoret i mellemtiden, og appen skal ikke vente paa den for evigt.
  useEffect(() => {
    if (!aabnNaarKlar || !indlaestUge) return;
    // Naaede hun at aabne noget andet, mens ugen blev hentet, er det dét, hun sidder
    // med. Saa skal vi ikke rive skaermen ud af haenderne paa hende for at vise den
    // opgave, hun trykkede paa for et oejeblik siden.
    if (openTask) { setAabnNaarKlar(null); return; }
    if (indlaestUge.aar !== aabnNaarKlar.aar || indlaestUge.uge !== aabnNaarKlar.uge) return;
    const t = instances.find((x) => x.id === aabnNaarKlar.id);
    if (t) setOpenTask(t);
    setAabnNaarKlar(null);
  }, [aabnNaarKlar, instances, indlaestUge, openTask]);

  // Fra listen over manglende til selve opgaven.
  function aabnManglende(m) {
    setVisMangler(false);
    setFraManglelisten(true);
    setDay(m.dag);
    const t = instances.find((x) => x.id === m.opgave_id);
    // Er opgaven allerede hentet, aabnes den med det samme — saa skal skaermen ikke
    // blinke gennem en hentning for ingenting.
    if (t) { setOpenTask(t); return; }
    setAabnNaarKlar({ id: m.opgave_id, aar: m.aar, uge: m.uge });
    setWeekOffset(ugerFraNu(m.aar, m.uge));
  }

  // Ud af en opgave. Kom hun fra manglelisten, er det DEN, hun skal tilbage til —
  // uanset om hun blev faerdig eller fortrød og vil tage en anden foerst. Listen er
  // en arbejdsseddel, man hakker af, ikke en genvej man bruger én gang.
  function lukOpgave() {
    setOpenTask(null);
    if (fraManglelisten) { setFraManglelisten(false); setVisMangler(true); }
  }

  // Returnerer true/false. Afslutningsflowet er nødt til at kunne se om det gik godt:
  // før returnerede funktionen ingenting, og et lydløst afbrud — fx når en planlægger
  // kigger i en kollegas plan — endte i en kvittering på noget der aldrig blev gemt.
  async function logMinutes(taskId, minutes, note = null, klientId = null) {
    if (viewingOther) return false;
    const m = Number(minutes);
    if (!employee || !m || m <= 0) return false;
    const task = instances.find((t) => t.id === taskId);
    if (!task) return false;
    // Atomar tilføjelse i databasen. Tidligere blev hele time_log-arrayet læst,
    // udvidet og skrevet tilbage — loggede to medarbejdere tid på samme opgave
    // samtidig, forsvandt den enes registrering sporløst.
    //
    // p_klient_id er noeglen fra telefonen. Funktionen LAEGGER TIL, saa uden den ville
    // en gentagelse — fordi svaret forsvandt undervejs — give 120 minutter i stedet for
    // 60, og det tal gaar direkte i loen og paa fakturaen. Med noeglen afvises
    // gentagelsen i databasen, og kaldet ser vellykket ud for appen.
    const { data: newLog, error } = await supabase.rpc("append_time_log", {
      p_instance_id: taskId, p_minutes: m, p_emp_id: employee.id, p_note: note,
      p_klient_id: klientId,
    });
    if (error) {
      console.error("append_time_log:", error.message);
      // Uden daekning laegges registreringen i koeen i stedet for at gaa tabt. Noeglen
      // foelger med, saa databasen afviser den hvis den alligevel naaede frem foerste
      // gang — funktionen LAEGGER TIL, og to gange 60 minutter er 120 paa loensedlen.
      //
      // Uden en noegle koeer vi ikke: saa kan vi ikke garantere at den kun taeller én
      // gang, og en fordoblet loen er vaerre end en registrering der maa laves om.
      if (erNetvaerksfejl(error) && klientId) {
        await koeTilfoej({ art: "tid", args: {
          opgaveId: taskId, minutter: m, empId: employee.id, note, noegle: klientId,
        } });
        // Vis tiden med det samme, saa hun kan komme videre. Den staar i koeen.
        setInstances((prev) => prev.map((t) => t.id === taskId
          ? { ...t, timeLog: [...(t.timeLog || []), { minutes: m, empId: employee.id, ts: Date.now(), kid: klientId }] }
          : t));
        opdaterKoeAntal();
        return true;
      }
      return false;
    }
    setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, timeLog: newLog, time_log: newLog } : t));
    return true;
  }

  // Returnerer ogsaa true/false, af samme grund som logMinutes.
  async function setStatus(taskId, done) {
    if (viewingOther) return false;
    // Afslutning er nu PR. MEDARBEJDER, ikke fælles for hele opgaven — ellers
    // ville én medarbejders "udført" lukke opgaven for de andre tilknyttede
    // medarbejdere, så de ikke længere kunne registrere tid eller afslutte
    // deres egen del. Databasefunktionen opdaterer atomart kun denne
    // medarbejders egen post og udleder selv om opgaven som helhed (status)
    // skal være "udført" — nemlig først når ALLE tilknyttede har afsluttet.
    const { data, error } = await supabase.rpc("set_employee_task_status", {
      p_instance_id: taskId, p_emp_id: employee.id, p_done: done,
    });
    if (error) {
      console.error("setStatus:", error.message);
      // Afslutningen saettes pr. medarbejder til en fast vaerdi — sender koeen den
      // to gange, staar der det samme bagefter. Den er derfor gratis at koee.
      if (erNetvaerksfejl(error)) {
        await koeTilfoej({ art: "status", args: {
          opgaveId: taskId, empId: employee.id, faerdig: done,
        } });
        setInstances((prev) => prev.map((t) => t.id === taskId
          ? { ...t,
              completed_by_employee: { ...(t.completed_by_employee || {}),
                ...(done ? { [employee.id]: new Date().toISOString() } : {}) } }
          : t));
        opdaterKoeAntal();
        return true;
      }
      return false;
    }
    setInstances((prev) => prev.map((t) => t.id === taskId
      ? {
          ...t,
          status: data.status,
          completed_by: data.completed_by,
          completed_at: data.completed_at,
          completedBy: data.completed_by,
          completedAt: data.completed_at,
          completed_by_employee: data.completed_by_employee,
          completedByEmployee: data.completed_by_employee,
        }
      : t));
    return true;
  }

  async function toggleChecklistItem(taskId, itemId) {
    if (viewingOther) return;
    const task = instances.find((t) => t.id === taskId);
    if (!task) return;
    const newChecklist = (task.checklist || []).map((i) => i.id === itemId ? { ...i, done: !i.done } : i);
    // Fluebenet saettes med det samme. Den gamle kode ventede paa databasen, saa uden
    // daekning skete der ingenting naar hun trykkede — og hun trykkede igen.
    setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, checklist: newChecklist } : t));
    const { error } = await supabase.from("instances").update({ checklist: newChecklist }).eq("id", taskId);
    if (error && erNetvaerksfejl(error)) {
      // Hele listen sendes, ikke det enkelte flueben. Sidste skriver vinder — er de
      // to paa opgaven og begge offline, forsvinder den enes flueben. Det er kendt og
      // accepteret; alternativet ville kraeve en samlefunktion i databasen.
      await koeTilfoej({ art: "tjekliste", args: { opgaveId: taskId, checklist: newChecklist } });
      opdaterKoeAntal();
    }
  }

  async function signOut() {
    // Er der noget i koeen, gaar det tabt ved log ud. Hun skal vide det foerst.
    const venter = (await koeAlle()).length;
    if (venter > 0 && !window.confirm(tr.queueOnSignOut(venter))) return;
    await supabase.auth.signOut();
    // Kopien indeholder kundenavne og adresser. Den maa ikke ligge og vente paa den
    // naeste der logger ind paa samme telefon.
    rydKopier();
    rydAdgang();
    try { localStorage.removeItem("wl_sidste_emp"); } catch { /* ingenting at goere */ }
    setEmployee(null); setInstances([]); setKopiHentet(null);
  }

  if (authLoading) return <div style={s.loading}>{T[lang].loading}</div>;
if (recoveryToken) return React.createElement("div", { style: { display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"#FFF0F5",fontFamily:"system-ui" } }, React.createElement("div", { style: { background:"#fff",borderRadius:16,padding:28,width:320,textAlign:"center",boxShadow:"0 4px 24px rgba(0,0,0,0.08)" } }, React.createElement("div", { style: { fontWeight:700,fontSize:16,marginBottom:8 } }, "Nulstil adgangskode"), React.createElement("div", { style: { fontSize:13,color:"#666",marginBottom:16 } }, "Klik for at fortsætte."), React.createElement("button", { onClick: confirmRecovery, disabled: recoveryLoading, style: { width:"100%",padding:"12px 0",borderRadius:10,border:"none",background:"#D6247A",color:"#fff",fontWeight:700 } }, recoveryLoading ? "Bekræfter…" : "Fortsæt")));
  if (passwordRecovery) return <SetNewPasswordScreen lang={lang} setLang={setLang} onDone={() => { setPasswordRecovery(false); window.history.replaceState(null, "", window.location.pathname); }} />;
        if (!session) return <LoginScreen lang={lang} setLang={setLang} initialError={recoveryError} />;
  if (dataLoading) return <div style={s.loading}>{T[lang].fetchingTasks}</div>;

  // Manglende daekning og manglende profil er to helt forskellige ting, og de skal
  // ikke ligne hinanden. Den ene loeser sig selv naar hun kommer ud af kaelderen; den
  // anden kraever et opkald til kontoret.
  if (ingenForbindelse) return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={{ fontSize: 40, textAlign: "center", marginBottom: 12 }}>📶</div>
        <div style={{ ...s.errorBox, background: "#FFFBEB", color: "#92400E", border: "1px solid #FDE68A" }}>
          {tr.offlineTitle}
        </div>
        <div style={{ fontSize: 13.5, color: "#64748B", lineHeight: 1.6, textAlign: "center", margin: "12px 4px 16px" }}>
          {tr.offlineHint}
        </div>
        <button style={s.loginBtn} onClick={() => window.location.reload()}>{tr.tryAgain}</button>
      </div>
    </div>
  );

  if (!employee) return <IngenProfil s={s} tr={tr} onSignOut={signOut} />;

  const { week: currentWeek, year: currentWeekYear } = weekInfoWithOffset(weekOffset);
  const ALL_DAYS = tr.days;
  const hasWeekendTasks = instances.some((t) => t.day === "Sat" || t.day === "Sun");
  const DAYS = (showWeekend || hasWeekendTasks) ? ALL_DAYS : ALL_DAYS.filter((d) => !d.weekend);
  const myTasks = instances.filter((t) => t.day === day);
  const schedule = computeDaySchedule(myTasks, travelSettings, employee);

  // Adgangsoplysninger kan ikke hentes uden daekning, og de maa ikke ligge klar paa
  // forhaand uden at nogen har bedt om dem. Loesningen er at HUN henter dem, mens hun
  // har daekning — og at appen minder om det inden hun koerer.
  //
  // Kun dagens opgaver, kun dem hun ikke allerede har hentet i dag, og kun naar der er
  // forbindelse. Er der ingen, staar der ingenting.
  const manglerAdgang = kopiHentet || !navigator.onLine
    ? []
    : myTasks.filter((t) => laesAdgang(t.id) === null);

  async function hentDagensAdgang() {
    setHenterAdgang(true);
    for (const t of manglerAdgang) {
      // p_kontekst = 'forhaand', saa loggen kan skelne. Ellers ville den se ud som om
      // hele dagens kunder blev besoegt kl. 06:45.
      const { data, error } = await supabase.rpc("hent_adgangsinfo", {
        p_instance_id: t.id, p_kontekst: "forhaand",
      });
      if (!error) gemAdgang(t.id, data ?? "");
    }
    setHenterAdgang(false);
    setAdgangHentetNu(true);
  }

  return (
    <div style={s.app}>

      {/* Ligger OVER hovedet, saa den ikke kan overses. Den lukker sig ikke selv:
          en rettelse der ikke naar ud er praecis det problem service workeren
          ellers ville skabe. */}
      {nyVersion && (
        <button
          onClick={() => nyVersion(true)}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                   width: "100%", border: "none", background: "#166534", color: "#fff",
                   padding: "13px 16px", fontSize: 14.5, fontWeight: 700, cursor: "pointer",
                   fontFamily: "inherit" }}>
          <span>{tr.newVersion}</span>
        </button>
      )}

      <InstallerBjaelke lang={lang} />

      {/* Koeen skal vaere synlig. Det vaerste ville vaere at hun troede alt var sendt,
          lukkede appen, og foerst opdagede dagen efter at tiden manglede. */}
      {koeAntal > 0 && (
        <div style={{ background: "#FFFBEB", borderBottom: "1px solid #FDE68A", padding: "10px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#92400E" }}>
                ↑ {tr.queueWaiting(koeAntal)}
              </div>
              <div style={{ fontSize: 12, color: "#B45309", marginTop: 1, lineHeight: 1.4 }}>
                {tr.queueHint}
              </div>
            </div>
            <button
              onClick={sendKoe} disabled={koeSender || !navigator.onLine}
              style={{ flexShrink: 0, border: "none", borderRadius: 8, background: "#B45309", color: "#fff",
                       padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer",
                       fontFamily: "inherit", opacity: (koeSender || !navigator.onLine) ? 0.5 : 1 }}>
              {koeSender ? tr.queueSending : tr.queueSendNow}
            </button>
          </div>
        </div>
      )}

      {/* Mindelsen om at hente adgangsoplysninger, mens der stadig er daekning.
          Staar over dagslisten, for den skal ses INDEN hun koerer — ikke naar hun
          staar ved doeren. */}
      {manglerAdgang.length > 0 && !adgangHentetNu && (
        <div style={{ background: "#EFF6FF", borderBottom: "1px solid #BFDBFE", padding: "10px 16px" }}>
          <div style={{ fontSize: 12.5, color: "#1E40AF", marginBottom: 8, lineHeight: 1.45 }}>
            {tr.fetchAccessHint(manglerAdgang.length)}
          </div>
          <button
            onClick={hentDagensAdgang} disabled={henterAdgang}
            style={{ width: "100%", border: "none", borderRadius: 9, background: "#1D4ED8", color: "#fff",
                     padding: "11px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer",
                     fontFamily: "inherit", opacity: henterAdgang ? 0.6 : 1 }}>
            🔒 {henterAdgang ? tr.fetchAccessWorking : tr.fetchAccessAll}
          </button>
        </div>
      )}
      {adgangHentetNu && manglerAdgang.length === 0 && (
        <div style={{ background: "#F0FDF4", borderBottom: "1px solid #BBF7D0", padding: "9px 16px",
                      fontSize: 12.5, color: "#166534" }}>
          ✓ {tr.fetchAccessDone}
        </div>
      )}

      {/* Hun skal kunne se at listen ikke er frisk. Uden det ville hun tro at en
          opgave kontoret har flyttet i morges stadig gaelder — og koere forgaeves. */}
      {kopiHentet && (
        <div style={{ background: "#FFFBEB", borderBottom: "1px solid #FDE68A",
                      padding: "9px 16px", color: "#92400E" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{tr.savedCopy}</div>
          <div style={{ fontSize: 12, marginTop: 1 }}>
            {tr.savedCopyFrom(new Date(kopiHentet).toLocaleString(lang === "da" ? "da-DK" : "en-GB",
              { weekday: "short", hour: "2-digit", minute: "2-digit" }))}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <img src="/app-icon.png" alt="Worklist" style={s.headerIcon} />
          <div style={{ minWidth: 0 }}>
            <div style={{ ...s.headerTitle, whiteSpace: "nowrap" }}>{tr.appName}</div>
            {/* Versionen stod her foer. Den er flyttet til Indstillinger, fordi
                datostrengen er lang nok til at braekke hele bjaelken paa en
                telefonskaerm — titlen ombroed til tre linjer, og avataren i hoejre
                side blev skaaret af. Den bruges én gang imellem af os, ikke dagligt
                af medarbejderen. */}
            <div style={{ ...s.headerSub, whiteSpace: "nowrap" }}>{tr.week} {currentWeek}</div>
          </div>
        </div>
        <div style={s.headerRight}>
          {/* Flagene er vaek. Sproget vaelges i Indstillinger, og to flag der gjorde
              det samme tog plads fra de knapper man rent faktisk bruger i marken. */}
          {/* Kun planlaeggere. Rengoeringsdamerne skal ikke have en knap de aldrig
              skal bruge — og databasen afviser kaldet uanset hvad. */}
          {employee?.is_admin && (
            <button
              style={{ border:"none", background:"#F0FDFA", color:"#0F766E", borderRadius:8, width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, padding:0 }}
              onClick={() => setNytMoede(true)}
              aria-label={lang === "da" ? "Nyt kundemøde" : "New customer meeting"}
              title={lang === "da" ? "Nyt kundemøde" : "New customer meeting"}>
              <CalendarPlus size={17} />
            </button>
          )}
          {/* Udraabstegnet vises KUN naar der er noget at raabe om.
              Der er fire ikoner plus avatar heroppe i forvejen, og bjaelken er
              braekket foer paa en smal skaerm. Et femte ikon, der normalt er tomt,
              ville koste plads hver eneste dag for at sige "ingenting".
              Naar det saa dukker op, betyder det noget — og saa skal tallet med,
              for «du mangler noget» og «du mangler sytten ting» er ikke samme besked. */}
          {mangler.length > 0 && (
            <button
              style={{ position:"relative", border:"none", background:"#FEF3C7", color:"#B45309", borderRadius:8, width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, padding:0 }}
              onClick={() => setVisMangler(true)}
              aria-label={`${tr.gapsAria} (${mangler.length})`}
              title={tr.gapsAria}>
              <AlertTriangle size={17} />
              {/* Tallet ligger OVEN PAA ikonet og ikke ved siden af.
                  Regnestykket: fem knapper à 34 px plus avatar og mellemrum fylder
                  254 px i hoejre side. Stod tallet ved siden af, voksede knappen til
                  omkring 52, og paa en 360 px skaerm var der saa ikke plads tilbage
                  til appens navn — bjaelken klipper hellere titlen end knapperne, saa
                  fejlen ville vise sig som et navn, der forsvandt.
                  fontSize og lineHeight staar fast: paa Android er stor systemskrift
                  udbredt, og et maerke der vokser, ville stikke ud over ikonet. */}
              <span style={{ position:"absolute", top:-4, right:-4, minWidth:16, height:16,
                             padding:"0 4px", borderRadius:99, background:"#B45309",
                             color:"#fff", fontSize:10.5, lineHeight:"16px", fontWeight:700,
                             textAlign:"center", boxSizing:"border-box" }}>
                {mangler.length}
              </span>
            </button>
          )}
          <button
            style={{ border:"none", background:"#FCE4EF", color:"#D6247A", borderRadius:8, width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, padding:0 }}
            onClick={() => setShowShop(true)}
            aria-label={lang === "da" ? "Bestil medarbejderprodukter" : "Order staff products"}
            title={lang === "da" ? "Bestil medarbejderprodukter" : "Order staff products"}>
            <Shirt size={17} />
          </button>
          <button
            style={{ border:"none", background:"#EEF2FF", color:"#4F46E5", borderRadius:8, width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, padding:0 }}
            onClick={() => setShowKm(true)}
            aria-label={lang === "da" ? "Min kørsel" : "My driving"}
            title={lang === "da" ? "Min kørsel" : "My driving"}>
            <Car size={17} />
          </button>
          <button
            style={{ border:"none", background:"#F1F5F9", color:"#334155", borderRadius:8, width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, padding:0 }}
            onClick={() => setShowHelp(true)}
            aria-label={lang === "da" ? "Hjælp" : "Help"}
            title={lang === "da" ? "Hjælp - sådan bruger du appen" : "Help - how to use the app"}>
            <HelpCircle size={17} />
          </button>
          <button
            style={{ ...s.signOutBtn, display:"flex", alignItems:"center", gap:6, color:"#E2E8F0", fontSize:13, fontWeight:600 }}
            onClick={() => setShowProfile((v) => !v)}>
            <span style={{ width:28, height:28, borderRadius:"50%", background:"#D6247A", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#fff", flexShrink:0 }}>
              {avatarTegn(employee.name, employee.id)}
            </span>
          </button>
        </div>
      </div>

      {/* Profile panel */}
      {showProfile && (
        <Indstillinger
          employee={employee} session={session} lang={lang} setLang={changeLang}
          dagsVisning={dagsVisning} setDagsVisning={setDagsVisning}
          onSignOut={signOut} onPasswordReset={sendPasswordReset}
          resetSent={resetSent} resetLoading={resetLoading}
          onLuk={() => setShowProfile(false)} />
      )}

      {/* Medarbejdervælger — kun for administratorer, og kun på computer.
          Man starter altid på sin egen plan; det her er noget man aktivt vælger. */}
      {allEmployees.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#64748B" }}>Se plan for</span>
          <select
            value={viewEmpId || ""}
            onChange={(e) => setViewEmpId(e.target.value || null)}
            // color staar eksplicit: uden den vaelger browseren selv en farve til
            // formularfelter, og i moerk tilstand er den hvid — paa den hvide
            // baggrund lige her.
            style={{ padding: "6px 10px", fontSize: 13, borderRadius: 8, border: "1px solid #CBD5E1",
                     background: "#fff", color: "#111111", fontFamily: "inherit" }}>
            <option value="">Mig selv</option>
            {allEmployees.filter((e) => !employee || e.id !== employee.id).map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      )}
      {viewingOther && (
        <div style={{ background: "#FFF7ED", borderLeft: "4px solid #C2410C", color: "#9A3412",
          padding: "10px 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>Du ser <b>{viewedEmployee ? viewedEmployee.name : "en kollegas"}</b> plan. Kun visning — du kan ikke registrere noget her.</span>
          <button onClick={() => setViewEmpId(null)}
            style={{ marginLeft: "auto", padding: "5px 12px", borderRadius: 999, border: "1px solid #C2410C",
              background: "#fff", color: "#9A3412", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Tilbage til min egen
          </button>
        </div>
      )}

      {/* Week navigation */}
      <div style={s.weekBar}>
        <button style={s.weekBtn} onClick={() => setWeekOffset((w) => w - 1)}><ChevronLeft size={20} /></button>
        <div style={{ ...s.weekLabel, flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>{tr.week} {currentWeek}</span>
            {weekOffset === 0 && <span style={s.thisWeekTag}>{tr.thisWeek}</span>}
          </div>
          <div style={{ fontSize: 11, color: "#94A3B8", fontWeight: 400 }}>{weekMeta(currentWeek, currentWeekYear)}</div>
        </div>
        <button style={s.weekBtn} onClick={() => setWeekOffset((w) => w + 1)}><ChevronRight size={20} /></button>
        {weekOffset !== 0 && (
          <button style={s.todayBtn} onClick={() => setWeekOffset(0)}>{tr.today}</button>
        )}
        <button
          style={{ ...s.todayBtn, background: showWeekend ? "#D6247A" : "#F1F5F9", color: showWeekend ? "#fff" : "#475569", marginLeft: 4 }}
          onClick={() => setShowWeekend((v) => !v)}
          title="Vis/skjul weekend">
          {showWeekend ? "Man–Søn" : "+ Weekend"}
        </button>
      </div>

      {/* Day tabs */}
      <div style={s.dayBar}>
        {DAYS.map((d) => {
          const count = instances.filter((t) => t.day === d.key).length;
          const isWeekend = d.weekend;
          // "I dag" gaelder kun i indevaerende uge. Uden weekOffset-tjekket fik samme
          // ugedag prikken i ALLE uger — bladrede man frem til uge 40, sad prikken
          // stadig paa torsdagen, selv om den dag ligger flere maaneder ude i fremtiden.
          const isToday = weekOffset === 0 && d.key === todayKey();
          // Beregn dato for denne dag i den aktuelle uge
          const dayIndex = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].indexOf(d.key);
          const jan4 = new Date(new Date().getFullYear(), 0, 4);
          const jan4Day = (jan4.getDay() + 6) % 7;
          const weekOneMonday = new Date(jan4);
          weekOneMonday.setDate(jan4.getDate() - jan4Day);
          const monday = new Date(weekOneMonday);
          monday.setDate(weekOneMonday.getDate() + (currentWeek - 1) * 7);
          const dayDate = new Date(monday);
          dayDate.setDate(monday.getDate() + dayIndex);
          const dateNum = dayDate.getDate();

          return (
            <button key={d.key}
              style={d.key === day
                ? { ...s.dayTabActive, ...(isWeekend ? { color: "#B45309", borderBottomColor: "#B45309" } : {}) }
                : { ...s.dayTab, ...(isWeekend ? { color: "#CBD5E1" } : {}) }
              }
              onClick={() => setDay(d.key)}>
              <span>{d.short} <span style={{ fontWeight: isToday ? 800 : "inherit" }}>{dateNum}</span></span>
              {isToday && d.key !== day && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#D6247A", display: "block", margin: "0 auto" }} />}
              {count > 0 && <span style={d.key === day ? s.dayCountActive : s.dayCount}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Task list */}
      <div style={s.list}>
        {myTasks.length === 0 && (
          <div style={s.empty}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>✓</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              {tr.noTasks(DAYS.find((d) => d.key === day)?.label.toLowerCase() || "")}
            </div>
            <div style={{ fontSize: 13, color: "#94A3B8" }}>{tr.freeDayNote}</div>
          </div>
        )}

        <BeskedBanner lang={lang} employee={employee} />

        {dagsVisning === "tid" && schedule.length > 0 && (
          <Tidslinje schedule={schedule} employee={employee} lang={lang}
            erIDag={day === todayWorkdayKey()} onVaelg={setOpenTask} />
        )}

        {dagsVisning === "liste" && schedule.map((seg) => {
          if (seg.type === "transport") {
            return (
              <div key={seg.key} style={s.transportRow}>
                <div style={s.transportIcon}><Car size={14} color="#64748B" /></div>
                <div style={s.transportInfo}>
                  {/* Hjemmebenene navngives, saa hun kan se hvornaar arbejdsdagen
                      begynder og slutter — og ikke tror det er en tur til en kunde. */}
                  <div style={s.transportTime}>
                    {fmtClock(seg.start)} · {seg.hjem === "ud" ? tr.travelFromHome : seg.hjem === "hjem" ? tr.travelToHome : tr.travel} · {fmtMin(seg.minutes)}
                  </div>
                  {seg.to && (
                    <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(seg.to)}`}
                      target="_blank" rel="noreferrer" style={s.transportNav}>
                      <Navigation size={11} /> {tr.navigate}
                    </a>
                  )}
                </div>
              </div>
            );
          }

          const t = seg.task;
          return (
            <TaskCard key={t.id} seg={seg} employee={employee} lang={lang} onClick={() => setOpenTask(t)} />
          );
        })}
      </div>

      {showShop && (
        <ShopPage
          employee={employee}
          lang={lang}
          supabaseClient={supabase}
          onClose={() => setShowShop(false)}
        />
      )}

      {showHelp && <HelpPage lang={lang} onClose={() => setShowHelp(false)}
                             onVisIgen={() => { setShowHelp(false); setVisVelkomst(true); }} />}

      {/* Ligger øverst af alt. Er det hendes første gang på den her telefon, skal
          hun ikke først skulle finde rundt i en dag, hun ikke forstår endnu. */}
      {visVelkomst && (
        <Velkomst lang={lang} navn={(employee?.name || "").split(" ")[0]}
                  onLuk={() => setVisVelkomst(false)} />
      )}

      {visMangler && (
        <ManglerPage
          lang={lang} tr={tr}
          raekker={mangler} henter={manglerHenter} fejl={manglerFejl}
          // Navnet med, naar det er en kollegas. Siden ligger over hele skaermen, saa
          // baanderet om at man ser en anden er skjult imens — og saa ville kontoret
          // sidde og kigge paa hendes liste under overskriften «Det du mangler».
          visEmpId={viewingOther ? viewEmpId : null}
          visEmpNavn={viewingOther ? (viewedEmployee?.name || "") : ""}
          onAabn={aabnManglende}
          onClose={() => setVisMangler(false)}
        />
      )}

      {showKm && (
        <TidOgKmPage
          lang={lang}
          supabaseClient={supabase}
          // Foelger «Se plan for». Uden det saa kontoret sine egne timer, mens de
          // troede, de hjalp hende med hendes — og gav hende svar paa et forkert tal.
          visEmpId={viewingOther ? viewEmpId : null}
          visEmpNavn={viewedEmployee?.name || ""}
          onClose={() => setShowKm(false)}
        />
      )}

      {/* Task modal. key paa opgavens id tvinger en frisk komponent pr. opgave — uden
          den genbruger React samme instans, og tilstande som "melding sendt" eller et
          halvt udfyldt afslutningsflow ville følge med over på næste opgave. */}
      {/* Et kundemoede er en aktivitet med et tilbud paa. Den skal aabne tilbuddet og
          ikke den almindelige opgaveskaerm — der er ingen tjekliste at hakke af, og
          det hun skal, er at skrive ned hvad kunden sagde. */}
      {openTask && openTask.type === "aktivitet" && (
        <TilbudSkaerm
          key={openTask.id}
          task={instances.find((t) => t.id === openTask.id) || openTask}
          employee={employee}
          supabaseClient={supabase}
          onSetStatus={setStatus}
          onLuk={lukOpgave}
        />
      )}

      {openTask && openTask.type !== "aktivitet" && (
        <TaskModal
          key={openTask.id}
          task={instances.find((t) => t.id === openTask.id) || openTask}
          employee={employee}
          lang={lang}
          onClose={lukOpgave}
          // Kvitteringens knap skal sige, hvor den faktisk foerer hen.
          fraListe={fraManglelisten}
          onLogMinutes={logMinutes}
          onSetStatus={setStatus}
          onToggleChecklist={toggleChecklistItem}
          supabaseClient={supabase}
        />
      )}

      {nytMoede && (
        <NytMoedeSkaerm
          supabaseClient={supabase} employee={employee}
          onLuk={() => setNytMoede(false)}
          onOprettet={() => { setNytMoede(false); setGenhent((n) => n + 1); }}
        />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Papirfarven under den tekst, der skal LÆSES.
//
// Knapper og felter bliver hvide — de skal se ud som noget, man trykker på. Men
// de flader, hvor der står sætninger, får en anelse varme i stedet for at være
// rent hvide. Skarp sort på skarp hvid giver visuel uro for en del ordblinde:
// bogstaverne kan synes at flimre eller flyde sammen. Forskellen her er så lille,
// at ingen lægger mærke til den — og det er meningen. Det skal ikke ligne en
// særlig udgave for nogen.
const PAPIR = "#FDFCF8";

const s = {
  app: { fontFamily:"'Inter',-apple-system,system-ui,sans-serif", background:"#F8FAFC", minHeight:"100svh", color:"#111111", display:"flex", flexDirection:"column" },
  loading: { display:"flex", alignItems:"center", justifyContent:"center", height:"100svh", fontSize:15, color:"#9C1B5D" },

  loginWrap: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100svh", padding:20, background:"#FFF6FA" },
  loginCard: { background:"#fff", borderRadius:20, padding:28, width:"100%", maxWidth:360, boxShadow:"0 8px 32px rgba(0,0,0,0.10)" },
  brand: { display:"flex", alignItems:"center", gap:12, marginBottom:28 },
  brandIcon: { width:44, height:44, borderRadius:12, objectFit:"cover" },
  brandTitle: { fontWeight:700, fontSize:17, color:"#111111" },
  brandSub: { fontSize:12, color:"#94A3B8" },
  loginLabel: { fontSize:13, fontWeight:600, color:"#475569", marginBottom:6 },
  loginInput: { width:"100%", padding:"12px 14px", borderRadius:10, border:"1.5px solid #E2E8F0", fontSize:15, color:"#111111", background:"#fff", boxSizing:"border-box", marginBottom:12 },
  loginBtn: { width:"100%", padding:"14px 0", borderRadius:12, border:"none", background:"#D6247A", color:"#fff", fontWeight:700, fontSize:15, cursor:"pointer", marginTop:4 },
  errorBox: { fontSize:13, color:"#B91C1C", padding:"10px 12px", background:"#FEF2F2", borderRadius:10, marginBottom:12 },

  langRow: { display:"flex", gap:8, marginBottom:16 },
  flagBtn: { fontSize:24, background:"none", border:"none", cursor:"pointer", padding:4, borderRadius:8, transition:"opacity 0.15s" },

  header: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, padding:"10px 12px", background:"#111111" },
  headerLeft: { display:"flex", alignItems:"center", gap:10, minWidth:0, flexShrink:1, overflow:"hidden" },
  // flexShrink:0 og nowrap: knapperne maa hellere skubbe titlen sammen end
  // selv blive klippet. Avataren er indgangen til indstillingerne — er den
  // uden for skaermen, findes de ikke.
  headerRight: { display:"flex", alignItems:"center", gap:6, flexShrink:0, flexWrap:"nowrap" },
  headerIcon: { width:34, height:34, borderRadius:8, objectFit:"cover", flexShrink:0 },
  headerTitle: { fontWeight:700, fontSize:15, color:"#fff" },
  headerSub: { fontSize:11, color:"#94A3B8" },
  signOutBtn: { border:"none", background:"transparent", color:"#64748B", cursor:"pointer", padding:4, display:"flex", alignItems:"center" },


  weekBar: { display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px 16px", background:"#fff", borderBottom:"1px solid #F1F5F9" },
  weekBtn: { border:"none", background:"#F1F5F9", borderRadius:8, padding:"6px 8px", cursor:"pointer", display:"flex", color:"#475569" },
  weekLabel: { fontSize:14, fontWeight:700, color:"#111111", minWidth:120, textAlign:"center", display:"flex", alignItems:"center", justifyContent:"center", gap:6 },
  thisWeekTag: { fontSize:11, fontWeight:700, color:"#D6247A", background:"#FCE4EF", padding:"2px 7px", borderRadius:99 },
  todayBtn: { border:"none", background:"#FCE4EF", color:"#D6247A", borderRadius:8, padding:"6px 12px", fontSize:12.5, fontWeight:700, cursor:"pointer" },

  dayBar: { display:"flex", background:"#fff", borderBottom:"1px solid #F1F5F9", padding:"0 8px" },
    // Samme stregtykkelse som den valgte dag, blot gennemsigtig. Uden den er den
  // valgte fane 2,5 px hoejere end de oevrige, og saa bliver bjaelkens underkant
  // skubbet ned netop dér — hvilket ser ud som en graa streg der stopper ved den
  // valgte dag.
  dayTab: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:"10px 0", border:"none", borderBottom:"2.5px solid transparent", background:"transparent", cursor:"pointer", fontSize:12.5, fontWeight:600, color:"#94A3B8", gap:3 },
  dayTabActive: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:"10px 0", border:"none", background:"transparent", cursor:"pointer", fontSize:12.5, fontWeight:700, color:"#D6247A", borderBottom:"2.5px solid #D6247A", gap:3 },
  dayCount: { fontSize:10, fontWeight:700, color:"#fff", background:"#CBD5E1", borderRadius:99, padding:"1px 6px", minWidth:16, textAlign:"center" },
  dayCountActive: { fontSize:10, fontWeight:700, color:"#fff", background:"#D6247A", borderRadius:99, padding:"1px 6px", minWidth:16, textAlign:"center" },

  list: { flex:1, display:"flex", flexDirection:"column", gap:8, padding:"12px 12px 40px" },
  empty: { textAlign:"center", padding:"60px 20px", color:"#94A3B8" },

  transportRow: { display:"flex", alignItems:"center", gap:10, padding:"8px 14px", background:"#F1F5F9", borderRadius:10, border:"1px dashed #CBD5E1" },
  transportIcon: { flexShrink:0 },
  transportInfo: { flex:1, display:"flex", alignItems:"center", justifyContent:"space-between" },
  transportTime: { fontSize:12.5, color:"#475569", fontWeight:500 },
  transportNav: { display:"flex", alignItems:"center", gap:4, fontSize:12, fontWeight:700, color:"#D6247A", textDecoration:"none" },

  taskCard: { display:"flex", alignItems:"stretch", background:PAPIR, borderRadius:14, boxShadow:"0 1px 3px rgba(0,0,0,0.06)", cursor:"pointer", overflow:"hidden", border:"1px solid #F1F5F9" },
  taskAccent: { width:4, flexShrink:0 },
  taskBody: { flex:1, padding:"13px 12px", minWidth:0 },
  taskRight: { display:"flex", alignItems:"center", paddingRight:12 },
  taskTime: { fontSize:11.5, fontWeight:700, color:"#D6247A", marginBottom:3 },
  taskTitle: { fontWeight:700, fontSize:15.5, color:"#111111", lineHeight:1.25, marginBottom:5 },
  // Kunden er nedtonet med vilje — se kommentaren i TaskCard. Den er bogholderi,
  // ikke navigation.
  taskCustomer: { display:"flex", alignItems:"center", gap:4, fontSize:11.5, color:"#94A3B8", fontWeight:500, marginBottom:6 },
  taskHvor: { display:"flex", alignItems:"flex-start", gap:6, marginBottom:6 },
  taskReference: { fontSize:14, fontWeight:700, color:"#111111", lineHeight:1.3 },
  taskAdresseTekst: { fontSize:13.5, fontWeight:600, color:"#334155", lineHeight:1.35 },
  taskNavKnap: { display:"inline-flex", alignItems:"center", gap:5, fontSize:12, fontWeight:700,
                 color:"#D6247A", background:"#FFF6FA", border:"1px solid #F5C8DC", borderRadius:8,
                 padding:"7px 11px", textDecoration:"none", marginBottom:7, minHeight:34 },
  taskAddress: { display:"flex", alignItems:"center", gap:5, fontSize:11.5, color:"#94A3B8", fontWeight:500, marginBottom:6, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  taskMeta: { display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" },
  taskDuration: { fontSize:12, color:"#64748B", fontWeight:500 },
  taskChecklist: { display:"flex", alignItems:"center", gap:3, fontSize:12, color:"#64748B" },
  taskLogged: { display:"flex", alignItems:"center", gap:3, fontSize:12, color:"#9C1B5D", fontWeight:600 },

  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:1000, display:"flex", alignItems:"stretch" },
  sheet: { width:"100%", height:"100%", maxHeight:"100%", background:PAPIR, borderRadius:0, display:"flex", flexDirection:"column", position:"relative" },
  dragHandle: { width:36, height:4, background:"#E2E8F0", borderRadius:99, margin:"12px auto 0" },
  sheetClose: { position:"absolute", top:12, right:14, border:"none", background:"#F1F5F9", borderRadius:99, width:32, height:32, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:"#475569" },
  sheetScroll: { flex:1, overflowY:"auto", padding:"8px 20px 20px" },

  sheetStatusRow: { display:"flex", alignItems:"center", gap:8, marginBottom:6, marginTop:8 },
  statusBadge: { fontSize:12, fontWeight:700, padding:"4px 10px", borderRadius:99 },
  sheetTitle: { fontWeight:800, fontSize:20, color:"#111111", lineHeight:1.25, marginBottom:4 },
  sheetMeta: { fontSize:13, color:"#64748B", marginBottom:16 },
  sheetSection: { marginBottom:20, paddingBottom:20, borderBottom:"1px solid #F1F5F9" },
  // Overskrifterne inde i opgaven — «Opgaver», «Video», «Produkter».
  //
  // De stod med STORE BOGSTAVER. Det ser ryddeligt ud, og det er sværere at
  // læse: et ord i kapitæler har ingen over- og underlængder, så ordbilledet
  // forsvinder, og bogstaverne skal stykkes sammen ét ad gangen. Det rammer
  // ordblinde hårdest, men det er langsommere for alle. Størrelsen er sat lidt
  // op til gengæld, så de stadig træder frem som overskrifter.
  sheetSectionTitle: { display:"flex", alignItems:"center", gap:6, fontSize:13, fontWeight:700, color:"#475569", letterSpacing:"0.01em", marginBottom:10 },
  sheetCustomer: { fontWeight:700, fontSize:16, color:"#111111", marginBottom:4 },
  sheetAddress: { display:"flex", alignItems:"flex-start", gap:6, fontSize:13.5, color:"#475569", marginBottom:12 },
  sheetAccessText: { fontSize:14, color:"#111111", lineHeight:1.6, background:"#FCE4EF", padding:"12px 14px", borderRadius:10 },
  navBtnLarge: { display:"flex", alignItems:"center", justifyContent:"center", gap:8, fontSize:15, fontWeight:700, color:"#fff", background:"#D6247A", borderRadius:12, padding:"14px 0", textDecoration:"none", width:"100%" },
  videoBtnLarge: { display:"flex", alignItems:"center", justifyContent:"center", gap:8, fontSize:14, fontWeight:600, color:"#111111", background:"#F1F5F9", borderRadius:12, padding:"13px 0", textDecoration:"none", width:"100%" },
  progPill: { marginLeft:"auto", fontSize:12, fontWeight:700, color:"#D6247A", background:"#FCE4EF", padding:"2px 10px", borderRadius:99 },
  checklistWrap: { display:"flex", flexDirection:"column", gap:2 },
  checklistItem: { borderRadius:10, overflow:"hidden" },
  checklistBtn: { display:"flex", alignItems:"flex-start", gap:12, width:"100%", border:"none", background:"transparent", padding:"10px 0", cursor:"pointer", textAlign:"left" },
  cbUnchecked: { width:22, height:22, borderRadius:6, border:"2px solid #CBD5E1", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", marginTop:1 },
  cbChecked: { width:22, height:22, borderRadius:6, border:"2px solid #111111", background:"#111111", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", marginTop:1 },
  checklistContent: { flex:1, display:"flex", flexDirection:"column", gap:3 },
  checklistText: { fontSize:14.5, lineHeight:1.4, fontWeight:500 },
  checklistDesc: { fontSize:12.5, color:"#64748B", lineHeight:1.5, fontStyle:"italic" },
  taskVideoBtn: { display:"inline-flex", alignItems:"center", gap:5, fontSize:12, fontWeight:600, color:"#9C1B5D", background:"#FCE4EF", borderRadius:8, padding:"5px 10px", textDecoration:"none", marginLeft:34, marginBottom:6 },
  timeProgress: { marginBottom:14 },
  timeBar: { height:6, background:"#F1F5F9", borderRadius:99, overflow:"hidden", marginBottom:6 },
  timeBarFill: { height:"100%", background:"#D6247A", borderRadius:99, transition:"width 0.3s" },
  timeMeta: { display:"flex", gap:6, fontSize:13, fontWeight:600, color:"#111111" },
  timeMeta2: { fontSize:12, color:"#94A3B8", marginTop:2 },
  // Advarsel + begrundelsesfelt naar registreret tid overskrider planlagt tid
  overrunBox: { background:"#FFFBEB", border:"1px solid #FDE68A", borderRadius:10, padding:"12px 14px", marginBottom:10 },
  overrunTitle: { fontSize:14, fontWeight:700, color:"#92400E", marginBottom:4 },
  overrunBody: { fontSize:13, color:"#92400E", lineHeight:1.45, marginBottom:10 },
  overrunInput: { width:"100%", boxSizing:"border-box", padding:"10px 12px", borderRadius:8, border:"1px solid #F59E0B",
    fontSize:15, fontFamily:"inherit", resize:"vertical", outline:"none", background:"#fff", color:"#111111" },
  overrunError: { fontSize:13, fontWeight:600, color:"#DC2626", marginTop:6 },

  // Kommentar og billeder
  notatKort: { background:"#F8FAFC", border:"1px solid #F1F5F9", borderRadius:10, padding:"10px 12px", marginBottom:8 },
  notatTid: { fontSize:11, fontWeight:700, color:"#94A3B8", marginBottom:4, display:"flex", alignItems:"center", gap:6 },
  notatArt: { background:"#FEE2E2", color:"#B91C1C", borderRadius:999, padding:"1px 8px", fontSize:10, fontWeight:800 },
  notatTekst: { fontSize:14, color:"#111111", lineHeight:1.45, whiteSpace:"pre-wrap" },
  // Én linje der kan skubbes til siden, frem for ombrydning. Ti billeder i en
  // ombrudt raekke ville skubbe tidsregistreringen langt ned paa en telefonskaerm.
  notatFotoRaekke: { display:"flex", gap:6, marginTop:8, overflowX:"auto", paddingBottom:4,
    WebkitOverflowScrolling:"touch", scrollbarWidth:"thin" },
  // Faste kvadrater. Billeder fra en telefon har vidt forskellige formater, og uden
  // en fast stoerrelse hopper hele opgavevisningen hver gang et billede er laest ind.
  notatFoto: { width:64, height:64, objectFit:"cover", borderRadius:8, display:"block", border:"1px solid #E2E8F0", flexShrink:0 },
  valgteRaekke: { display:"flex", gap:6, marginBottom:8, overflowX:"auto", paddingBottom:4,
    WebkitOverflowScrolling:"touch", scrollbarWidth:"thin" },
  valgtFoto: { width:56, height:56, objectFit:"cover", borderRadius:8, display:"block", border:"1px solid #99F6E4" },
  fjernFoto: { position:"absolute", top:-6, right:-6, width:20, height:20, borderRadius:999, border:"none",
    background:"#111", color:"#fff", fontSize:14, lineHeight:"18px", cursor:"pointer", padding:0, fontFamily:"inherit" },
  fotoTaeller: { fontSize:11, color:"#94A3B8", marginTop:5, textAlign:"right" },

  // Afslut opgave
  afslutTop: { background:"#111", color:"#fff", padding:"11px 14px", fontSize:13, display:"flex",
    alignItems:"center", justifyContent:"space-between", flexShrink:0 },
  afslutTilbage: { border:"none", background:"none", color:"#fff", fontSize:13, display:"flex",
    alignItems:"center", gap:4, cursor:"pointer", padding:0, fontFamily:"inherit" },
  fremdriftSpor: { height:4, background:"#E2E8F0", flexShrink:0 },
  fremdriftFyld: { height:4, background:"#D6247A", transition:"width 160ms ease-out" },
  // Bunden er en fast bjaelke, saa den handling der foerer videre altid er synlig.
  // Foer laa afslut-knappen nederst efter alt indhold, og paa en opgave med en lang
  // tjekliste skulle man scrolle forbi hele skaermen for at komme til den.
  afslutBund: { borderTop:"1px solid #F1F5F9", background:"#fff", flexShrink:0,
    padding:"12px 16px calc(14px + env(safe-area-inset-bottom))" },
  trinSpoergsmaal: { fontSize:19, fontWeight:600, color:"#111111", lineHeight:1.35 },
  trinHjaelp: { fontSize:14, color:"#64748B", lineHeight:1.5, marginTop:6 },
  trinFod: { fontSize:12.5, color:"#94A3B8", marginTop:12, textAlign:"center", lineHeight:1.5 },
  springBtn: { width:"100%", border:"none", background:"none", fontSize:13.5, color:"#64748B",
    textDecoration:"underline", padding:"10px 0", marginTop:6, cursor:"pointer", fontFamily:"inherit" },
  trinAllerede: { fontSize:13, color:"#9C1B5D", background:"#FFF6FA", borderRadius:8,
    padding:"8px 11px", marginTop:10, lineHeight:1.45 },

  // Adgang og noegle
  adgangBtn: { width:"100%", padding:"14px 0", borderRadius:12, border:"1.5px solid #E2E8F0",
    background:"#fff", fontSize:15, fontWeight:600, color:"#111111", cursor:"pointer", fontFamily:"inherit" },
  adgangHint: { fontSize:12.5, color:"#94A3B8", lineHeight:1.5, marginTop:8 },
  adgangLogget: { fontSize:12, color:"#94A3B8", fontStyle:"italic", marginTop:8 },
  noegleMaerke: { display:"inline-block", background:"#FFFBEB", border:"1px solid #FDE68A",
    color:"#92400E", borderRadius:8, padding:"4px 9px", fontSize:12.5, fontWeight:700, marginTop:6 },

  // Meld et problem
  problemBtn: { width:"100%", border:"1.5px solid #E2E8F0", background:"#fff", borderRadius:12,
    padding:"13px 0", marginTop:10, fontSize:15, fontWeight:600, color:"#475569",
    cursor:"pointer", fontFamily:"inherit" },
  problemSendt: { fontSize:13.5, color:"#065F46", background:"#ECFDF5", border:"1px solid #A7F3D0",
    borderRadius:12, padding:"12px 14px", marginTop:10, textAlign:"center", lineHeight:1.45 },
  valgKortGul: { width:"100%", textAlign:"left", border:"1.5px solid #FCD34D", background:"#FFFBEB",
    borderRadius:14, padding:"16px 15px", marginTop:14, cursor:"pointer", fontFamily:"inherit", display:"block" },
  valgKortRoed: { width:"100%", textAlign:"left", border:"1.5px solid #FCA5A5", background:"#FEF2F2",
    borderRadius:14, padding:"16px 15px", marginTop:10, cursor:"pointer", fontFamily:"inherit", display:"block" },
  valgKortTitel: { fontSize:16.5, fontWeight:700, color:"#111111" },
  valgKortTekst: { fontSize:13.5, color:"#475569", lineHeight:1.5, marginTop:5 },
  datoFelt: { width:"100%", boxSizing:"border-box", padding:"14px 12px", fontSize:16,
    borderRadius:10, border:"1.5px solid #E2E8F0", fontFamily:"inherit", color:"#111111", background:"#fff" },
  storTid: { fontSize:44, fontWeight:600, color:"#111111", lineHeight:1.05 },
  storTidEnhed: { fontSize:22, fontWeight:500, color:"#94A3B8" },
  maerkeOk: { display:"inline-block", background:"#ECFDF5", color:"#166534", borderRadius:99, padding:"4px 13px", fontSize:12.5, fontWeight:600, marginTop:9 },
  maerkeOver: { display:"inline-block", background:"#FFFBEB", color:"#92400E", borderRadius:99, padding:"4px 13px", fontSize:12.5, fontWeight:600, marginTop:9 },
  maerkeUnder: { display:"inline-block", background:"#F1F5F9", color:"#475569", borderRadius:99, padding:"4px 13px", fontSize:12.5, fontWeight:600, marginTop:9 },
  stepperLabel: { fontSize:12.5, color:"#64748B", marginBottom:6 },
  stepperRaekke: { display:"flex", alignItems:"center", gap:10 },
  // 60 px hoeje knapper. Maalgruppen staar ofte med vaade eller behandskede haender,
  // og den gamle rullevaelger havde en trykflade paa under 20 px.
  stepperBtn: { width:64, height:58, border:"1.5px solid #E2E8F0", borderRadius:12, background:"#fff",
    fontSize:28, fontWeight:500, color:"#111111", cursor:"pointer", flexShrink:0, fontFamily:"inherit",
    display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 },
  stepperTal: { flex:1, textAlign:"center", fontSize:26, fontWeight:600, color:"#111111" },
  // Tallet kan skrives direkte. − og + gaar i spring af fem, fordi det er det
  // almindelige, men 18 minutter skal ogsaa kunne registreres — og 18 tryk paa
  // plus er ikke et svar. Feltet ser ud som tallet gjorde foer; det skal ikke
  // ligne en formular, bare et tal man kan rette i.
  stepperFelt: { flex:1, width:"100%", minWidth:0, textAlign:"center", fontSize:26, fontWeight:600,
    color:"#111111", border:"1.5px solid transparent", borderRadius:12, background:"#F8FAFC",
    padding:"10px 0", fontFamily:"inherit", MozAppearance:"textfield" },
  primaerStor: { width:"100%", padding:"16px 0", borderRadius:12, border:"none", background:"#D6247A",
    color:"#fff", fontWeight:700, fontSize:16, cursor:"pointer", fontFamily:"inherit" },
  sekundaerStor: { width:"100%", padding:"15px 0", borderRadius:12, border:"1.5px solid #E2E8F0",
    background:"#fff", color:"#111111", fontWeight:600, fontSize:15, cursor:"pointer", fontFamily:"inherit" },
  afslutBtn: { width:"100%", padding:"16px 0", borderRadius:12, border:"none", background:"#16A34A",
    color:"#fff", fontWeight:700, fontSize:16, cursor:"pointer", fontFamily:"inherit" },
  nexusBtn: { width:"100%", padding:"15px 0", borderRadius:12, border:"none", background:"#4F46E5",
    color:"#fff", fontWeight:700, fontSize:15, cursor:"pointer", marginTop:14, fontFamily:"inherit" },
  nexusTjek: { width:"100%", display:"flex", alignItems:"center", gap:12, textAlign:"left",
    padding:"15px 14px", borderRadius:12, border:"1.5px solid #E2E8F0", background:"#fff",
    fontSize:15, color:"#111111", cursor:"pointer", marginTop:10, fontFamily:"inherit" },
  nexusTjekAktiv: { width:"100%", display:"flex", alignItems:"center", gap:12, textAlign:"left",
    padding:"15px 14px", borderRadius:12, border:"2px solid #4F46E5", background:"#EEF2FF",
    fontSize:15, fontWeight:600, color:"#312E81", cursor:"pointer", marginTop:10, fontFamily:"inherit" },
  tjekFirkant: { width:26, height:26, borderRadius:7, border:"2px solid #CBD5E1", flexShrink:0 },
  tjekFirkantAktiv: { width:26, height:26, borderRadius:7, background:"#4F46E5", flexShrink:0,
    display:"flex", alignItems:"center", justifyContent:"center" },
  kvitteringCirkel: { width:64, height:64, borderRadius:"50%", background:"#ECFDF5", margin:"0 auto",
    display:"flex", alignItems:"center", justifyContent:"center" },
  kvitteringTitel: { fontSize:19, fontWeight:600, color:"#111111", marginTop:14 },
  kvitteringKunde: { fontSize:14, color:"#64748B", marginTop:4 },
  kvitteringKort: { background:"#F8FAFC", borderRadius:12, padding:"6px 14px", marginTop:16, textAlign:"left" },
  kvitteringRaekke: { display:"flex", justifyContent:"space-between", alignItems:"center",
    fontSize:14.5, color:"#111111", padding:"11px 0", borderBottom:"1px solid #F1F5F9" },
  kvitteringNote: { fontSize:12.5, color:"#94A3B8", marginTop:14, lineHeight:1.5 },
  notatSlettet: { fontSize:11, color:"#94A3B8", fontStyle:"italic", marginTop:6 },
  notatInput: { width:"100%", boxSizing:"border-box", padding:"10px 12px", borderRadius:10, border:"1.5px solid #E2E8F0",
    fontSize:15, fontFamily:"inherit", resize:"vertical", outline:"none", background:"#fff", color:"#111111" },
  notatFejl: { fontSize:13, fontWeight:600, color:"#DC2626", marginTop:8 },
  // Samme grund som sheetSectionTitle: ingen kapitæler.
  tilbudAfsnit: { fontSize:12.5, fontWeight:800, letterSpacing:".01em",
    color:"#9C1B5D", marginTop:20, marginBottom:2 },
  tilbudHint: { fontSize:12, color:"#64748B", marginTop:6, lineHeight:1.45 },
  notatFotoBtn: { flex:1, padding:"12px", borderRadius:10, border:"1.5px solid #E2E8F0", background:"#fff",
    fontSize:15, fontWeight:600, color:"#111111", cursor:"pointer", fontFamily:"inherit" },
  doneLarge: { width:"100%", padding:"16px 0", borderRadius:14, border:"2px solid #E2E8F0", background:"#fff", color:"#475569", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 },
  doneActiveLarge: { width:"100%", padding:"16px 0", borderRadius:14, border:"2px solid #22C55E", background:"#ECFDF5", color:"#16A34A", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 },
};

// ── Employee shop page ────────────────────────────────────────────────────────
function ShopPage({ employee, lang, supabaseClient, onClose }) {
  const [items, setItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [view, setView] = useState("shop");

  // Bestillingsnummeret laves naar skaermen aabnes og ikke inde i save(). Fejlede
  // bestillingen halvvejs — to varer oprettet, den tredje ikke — fik det naeste forsoeg
  // foer sit eget nummer, og de to foerste varer blev bestilt igen. Nu rammer de samme
  // raekker, og planlaeggeren ser én bestilling.
  const [orderGroupId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data: cats } = await supabaseClient.from("inventory_categories").select("id").eq("type", "medarbejder");
      if (cats?.length) {
        const { data: products } = await supabaseClient
          .from("inventory_items")
          .select("*, inventory_categories(name, icon)")
          .in("category_id", cats.map((c) => c.id))
          .order("name");
        setItems(products || []);
      }
      const { data: txns } = await supabaseClient
        .from("inventory_transactions")
        .select("*, inventory_items(name, unit, category_id, inventory_categories(type))")
        .eq("employee_id", employee.id)
        .eq("type", "out")
        .order("id", { ascending: false })
        .limit(30);
      // Filtrer kun medarbejderprodukter
      setHistory((txns || []).filter((tx) => tx.inventory_items?.inventory_categories?.type === "medarbejder"));
      setLoading(false);
    }
    load();
  }, []);

  async function submitOrder() {
    const entries = Object.entries(selected).filter(([, q]) => Number(q) > 0);
    if (!entries.length) return;
    setSaving(true);
    // Bestillingen oprettes som "pending" — lageret nedskrives først når
    // planlæggeren godkender udleveringen (se InventoryView i Rengøringsplan).
    for (const [itemId, qty] of entries) {
      const amount = Number(qty);
      const item = items.find((i) => i.id === itemId);
      if (!item) continue;
      const { error: insertErr } = await supabaseClient.from("inventory_transactions").upsert({
        id: `${orderGroupId}-${itemId}`,
        item_id: itemId, quantity: -amount, type: "out", status: "pending", order_group_id: orderGroupId,
        // Navnet staar IKKE her. Det ligger i employee_id lige nedenunder, og
        // planlaegningen viser det derfra. Stod det begge steder, kom det ud som
        // "Bestilt af Nadine Bremholm · Nadine Bremholm".
        reason: lang === "da" ? "Bestilt" : "Ordered",
        employee_id: employee.id,
      }, { onConflict: "id" });
      if (insertErr) { console.error("order upsert:", insertErr.message); alert(`Kunne ikke oprette bestillingen for "${item.name}" — prøv igen.`); setSaving(false); return; }
    }
    // Giv planlæggeren besked om at der venter en bestilling til godkendelse.
    try {
      const { data: admins } = await supabaseClient.from("employees").select("app_email, name").eq("is_admin", true);
      const itemsList = entries.map(([itemId, qty]) => {
        const item = items.find((i) => i.id === itemId);
        return `${qty} × ${item ? item.name : itemId}`;
      }).join(", ");
      // Gik foer gennem en raa fetch uden Authorization-header. Det virkede kun fordi
      // send-email stod helt aaben, og det var netop hullet: enhver der kendte URL'en
      // kunne sende mail i Jammerbugt Rengoerings navn. invoke saetter medarbejderens
      // eget token paa, og det er nu et krav i funktionen.
      await Promise.all((admins || []).filter((a) => a.app_email).map((admin) =>
        supabaseClient.functions.invoke("send-email", {
          body: {
            email: admin.app_email,
            name: admin.name,
            subject: `Ny bestilling af medarbejderprodukter - ${employee.name}`,
            html: `
              <h2>Ny bestilling</h2>
              <p><strong>${employee.name}</strong> har bestilt:</p>
              <p>${itemsList}</p>
              <p>Godkend udleveringen i Rengøringsplan under Lager, så lageret opdateres.</p>
            `,
          },
        }).catch((e) => console.error("notify admin failed", e))
      ));
    } catch (e) { console.error("notify admins failed:", e); }
    const { data: txns } = await supabaseClient
      .from("inventory_transactions")
      .select("*, inventory_items(name, unit, inventory_categories(type))")
      .eq("employee_id", employee.id).eq("type", "out")
      .order("id", { ascending: false }).limit(30);
    setHistory((txns || []).filter((tx) => tx.inventory_items?.inventory_categories?.type === "medarbejder"));
    setSelected({});
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  const orderCount = Object.values(selected).filter((q) => Number(q) > 0).length;

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.sheet, maxHeight: "92svh" }} onClick={(e) => e.stopPropagation()}>
        <div style={s.dragHandle} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 0" }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "#111111" }}>
            {"\uD83D\uDC55"} {lang === "da" ? "Medarbejderprodukter" : "Staff products"}
          </div>
          <button style={s.sheetClose} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ display: "flex", padding: "10px 20px 0", gap: 8, borderBottom: "1px solid #F1F5F9" }}>
          {[["shop", lang === "da" ? "Bestil" : "Order"], ["history", lang === "da" ? "Historik" : "History"]].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)}
              style={{ padding: "8px 16px", border: "none", background: "transparent", fontWeight: view === k ? 700 : 500, color: view === k ? "#D6247A" : "#94A3B8", borderBottom: view === k ? "2.5px solid #D6247A" : "2.5px solid transparent", cursor: "pointer", fontSize: 14 }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 20px" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>Indlæser…</div>
          ) : view === "shop" ? (
            items.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#94A3B8", fontSize: 14 }}>
                {lang === "da" ? "Ingen medarbejderprodukter" : "No staff products"}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {items.map((item) => {
                  const qty = selected[item.id] || "";
                  const hasQty = Number(qty) > 0;
                  return (
                    <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #F1F5F9", background: hasQty ? "#FFF6FA" : "transparent", borderRadius: hasQty ? 10 : 0, paddingLeft: hasQty ? 10 : 0 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: hasQty ? 700 : 500, color: "#111111" }}>{item.inventory_categories?.icon} {item.name}</div>
                        <div style={{ fontSize: 12, color: "#94A3B8" }}>{lang === "da" ? "Lager" : "Stock"}: {item.stock} {item.unit}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button style={{ width:32,height:32,borderRadius:"50%",border:"1.5px solid #E2E8F0",background:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#475569" }}
                          onClick={() => setSelected((prev) => ({ ...prev, [item.id]: Math.max(0,(Number(prev[item.id])||0)-1)||"" }))}>-</button>
                        <input type="number" min={0} max={item.stock} step={1} inputMode="numeric" pattern="[0-9]*"
                          style={{ width:52,padding:"7px 4px",borderRadius:8,border:hasQty?"2px solid #D6247A":"1.5px solid #E2E8F0",fontSize:15,textAlign:"center",color:"#111111",background:"#fff",fontWeight:hasQty?700:400 }}
                          value={qty} onChange={(e) => setSelected((prev) => ({ ...prev, [item.id]: e.target.value.replace(/[^0-9]/g, "") }))} />
                        <button style={{ width:32,height:32,borderRadius:"50%",border:"1.5px solid #D6247A",background:"#FCE4EF",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#D6247A" }}
                          onClick={() => setSelected((prev) => ({ ...prev, [item.id]: (Number(prev[item.id])||0)+1 }))}>+</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            history.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#94A3B8", fontSize: 14 }}>
                {lang === "da" ? "Ingen bestillinger endnu" : "No orders yet"}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {history.map((tx) => (
                  <div key={tx.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #F1F5F9", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize:14,color:"#111111" }}>{tx.inventory_items?.name}</div>
                      {tx.status === "pending" && <div style={{ fontSize: 11, fontWeight: 700, color: "#B45309" }}>{lang === "da" ? "Afventer godkendelse" : "Awaiting approval"}</div>}
                      {tx.status === "rejected" && <div style={{ fontSize: 11, fontWeight: 700, color: "#DC2626" }}>{lang === "da" ? "Afvist" : "Rejected"}</div>}
                    </div>
                    <div style={{ fontSize:14,fontWeight:700,color:"#111111" }}>{Math.abs(tx.quantity)} {tx.inventory_items?.unit}</div>
                    {tx.created_at && <div style={{ fontSize: 11, color: "#94A3B8", flexShrink: 0 }}>{new Date(tx.created_at).toLocaleDateString("da-DK", { day: "numeric", month: "short" })}</div>}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
        {view === "shop" && (
          <div style={{ padding:"12px 20px 32px",borderTop:"1px solid #F1F5F9" }}>
            <button
              style={{ ...s.doneLarge,background:saved?"#ECFDF5":orderCount>0?"#D6247A":"#fff",color:saved?"#16A34A":orderCount>0?"#fff":"#475569",borderColor:saved?"#22C55E":orderCount>0?"#D6247A":"#E2E8F0",fontWeight:700 }}
              onClick={submitOrder} disabled={saving||orderCount===0}>
              {saved?("\u2713 "+(lang==="da"?"Bestilling sendt":"Order sent")):saving?"...":(orderCount>0?(lang==="da"?"Bestil ":"Order ")+orderCount+" "+(lang==="da"?"produkter":"products"):(lang==="da"?"Vaelg produkter":"Select products"))}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


// ── Min tid og kørsel ────────────────────────────────────────────────────────
//
// Hvorfor siden findes: der var laebende diskussioner om timer, fordi der er TRE tal
// og ikke to. Planlagt tid er hvad kontoret afsatte. Registreret tid er hvad hun
// trykkede. Godkendt tid er hvad kontoret har sat flueben ved — og kun dét naar
// Danloen-filen. Hun troede registreret var lig udbetalt, og saa ringede hun.
//
// Nu kan hun se alle tre selv, og hvad forskellen skyldes.
//
// Tallene hentes gennem mine_timer og mine_km i databasen, ikke ved at regne paa
// opgaverne her. Datoen skal udledes af aar + ISO-uge + ugedag, og findes den
// beregning to steder, driver de fra hinanden — saa ville hendes tal ikke passe med
// kontorets, og saa var vi lige vidt.

const MDR_DA = ["Januar","Februar","Marts","April","Maj","Juni",
                "Juli","August","September","Oktober","November","December"];
const MDR_EN = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

// Timer med dansk komma. 135 minutter bliver til 2,25.
function timerTekst(minutter, da) {
  const t = (Number(minutter) || 0) / 60;
  const s = t.toFixed(2).replace(/0$/, "").replace(/[.,]$/, "");
  return da ? s.replace(".", ",") : s;
}

// visEmpId er den medarbejder, kontoret har valgt i «Se plan for». Er den tom, viser
// siden den indloggedes egne tal.
//
// Selve afgoerelsen af, om man MAA se en anden, ligger ikke her. Databasen ser bort
// fra id'et, med mindre kalderen er planlaegger — laa afgoerelsen i appen, kunne den
// omgaas ved at kalde API'et direkte. Her bruges det kun til at vise det rigtige navn.
// ── Det du mangler ───────────────────────────────────────────────────────────
// Appen henter én uge ad gangen. Det betyder, at en opgave hun glemte for tre uger
// siden var usynlig: hun skulle VIDE at den var der, og bladre tilbage til ugen for
// at finde den. Paamindelsesmailen kendte den godt — men mailen kan man ikke trykke
// paa, og den naar kun syv dage tilbage.
//
// Derfor denne side. Den henter mine_manglende(), som bruger noejagtig samme
// definition som mailen, saa de to aldrig kan sige hver sit.
//
// AEldste oeverst. Det er ikke en smagssag: naar maaneden lukker, er det de gamle
// opgaver, der falder ud af loennen, og de nyeste kan hun altid naa. En liste med
// nyeste foerst ville begrave netop dem, det haster med.
function ManglerPage({ lang, tr, raekker, henter, fejl, visEmpId, visEmpNavn, onAabn, onClose }) {
  const da = lang === "da";
  const anden = !!visEmpNavn;
  const manglerTekst = (m) => (m === "tid og udført" ? tr.gapsNeedBoth
                             : m === "tid" ? tr.gapsNeedTime
                             : tr.gapsNeedDone);
  const dagTekst = (iso) => new Date(iso + "T12:00:00")
    .toLocaleDateString(da ? "da-DK" : "en-GB",
      { weekday: "short", day: "numeric", month: "short" });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 50,
                  display: "flex", flexDirection: "column" }}>
      {/* env(safe-area-inset-top): fuldskaermsside, saa uden den lægger overskriften
          sig ind under statuslinjen paa iPhone. Paa Android er tallet som regel nul. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "calc(14px + env(safe-area-inset-top)) 16px 12px",
                    borderBottom: "1px solid #F1F5F9", flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 17, minWidth: 0, paddingRight: 10,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {anden ? medSolsikke(visEmpNavn, visEmpId) : tr.gapsTitle}
        </div>
        <button onClick={onClose} aria-label={da ? "Luk" : "Close"}
          style={{ border: "none", background: "#F1F5F9", borderRadius: 8, width: 34, height: 34,
                   display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <X size={17} />
        </button>
      </div>

      {anden && (
        <div style={{ background: "#FFF7ED", borderLeft: "4px solid #C2410C", color: "#9A3412",
                      padding: "9px 14px", fontSize: 12.5, lineHeight: 1.45, flexShrink: 0 }}>
          {da ? "Du ser en kollegas liste. Kun visning — du kan ikke registrere for hende."
              : "You are viewing a colleague's list. View only — you cannot register on her behalf."}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto",
                    padding: "14px 16px calc(28px + env(safe-area-inset-bottom))" }}>
        {henter && (
          <div style={{ color: "#94A3B8", padding: 20, textAlign: "center" }}>{tr.gapsLoading}</div>
        )}

        {/* Tom liste og "kunne ikke hente" ser ens ud, hvis man ikke skelner — og her
            er forskellen "du er faerdig" mod "vi ved det ikke". */}
        {!henter && fejl && (
          <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 10,
                        padding: "12px 14px", fontSize: 13.5, lineHeight: 1.5 }}>
            {tr.gapsError}
          </div>
        )}

        {!henter && !fejl && raekker.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px" }}>
            <CheckCircle2 size={40} color="#16A34A" strokeWidth={1.8} />
            <div style={{ marginTop: 12, fontSize: 14.5, color: "#475569", lineHeight: 1.5 }}>
              {anden ? tr.gapsNoneOther(visEmpNavn) : tr.gapsNone}
            </div>
          </div>
        )}

        {!henter && !fejl && raekker.length > 0 && (
          <>
            {/* «Du mangler» duer ikke, naar kontoret kigger paa hende. Det er ikke
                sprogpynt: den planlaegger, der laeser sin egen skaerm som en besked
                om sit eget arbejde, ringer ikke til hende. */}
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
              {anden ? tr.gapsLeadOther(raekker.length, visEmpNavn)
                     : tr.gapsLead(raekker.length)}
            </div>
            <div style={{ fontSize: 12.5, color: "#64748B", lineHeight: 1.5, marginBottom: 12 }}>
              {tr.gapsHint}
            </div>
            <div style={{ background: "#FEF3C7", borderLeft: "4px solid #D97706", borderRadius: 8,
                          padding: "10px 12px", fontSize: 12.5, color: "#92400E",
                          lineHeight: 1.5, marginBottom: 14 }}>
              {tr.gapsMonthWarn}
            </div>

            {raekker.map((m) => (
              // Hele kortet er trykflade, ikke en lille pil i kanten. Det skal kunne
              // rammes med en behandsket finger — samme grund som paa nexus-trinnet.
              <button key={m.opgave_id} type="button" onClick={() => onAabn(m)}
                style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 8,
                         border: "1px solid #E2E8F0", borderRadius: 12, background: "#fff",
                         padding: "11px 13px", cursor: "pointer", fontFamily: "inherit",
                         minHeight: 44 }}>
                <div style={{ display: "flex", justifyContent: "space-between",
                              alignItems: "baseline", gap: 10 }}>
                  {/* Klokkeslaettet med, naar det er der: to besoeg hos samme borger
                      samme dag kan ellers kun skelnes ved at aabne dem. */}
                  <span style={{ fontSize: 12.5, color: "#64748B", whiteSpace: "nowrap" }}>
                    {dagTekst(m.opgavedato)}
                    {m.scheduled_time && ` · ${String(m.scheduled_time).slice(0, 5)}`}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "#B45309",
                                 background: "#FFFBEB", borderRadius: 6, padding: "3px 7px",
                                 whiteSpace: "nowrap" }}>
                    {manglerTekst(m.mangler)}
                  </span>
                </div>
                {/* Samme regel som paa opgavekortet ude i dagen — opgaveIdentitet
                    afgoer, om det er kunden eller borgeren, der hoerer oeverst. Skrev
                    listen sin egen regel, ville de to skaerme kunne komme til at kalde
                    den samme opgave to forskellige ting. */}
                <div style={{ fontSize: 14.5, fontWeight: 600, color: "#111111",
                              marginTop: 3, lineHeight: 1.35 }}>
                  {opgaveIdentitet(m).primaer || m.titel}
                </div>
                <div style={{ fontSize: 12.5, color: "#94A3B8", marginTop: 2, lineHeight: 1.4 }}>
                  {[opgaveIdentitet(m).sekundaer, m.titel,
                    m.minutter > 0 ? tr.gapsLogged(m.minutter) : null]
                    .filter(Boolean).join(" · ")}
                </div>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TidOgKmPage({ lang, supabaseClient, onClose, visEmpId, visEmpNavn }) {
  const da = lang === "da";
  const anden = !!visEmpId;
  const nu = new Date();
  const [fane, setFane] = useState("timer");
  const [aar, setAar] = useState(nu.getFullYear());
  const [maaned, setMaaned] = useState(nu.getMonth() + 1);   // 1-12
  const [timer, setTimer] = useState([]);
  const [km, setKm] = useState([]);
  const [henter, setHenter] = useState(true);
  const [fejl, setFejl] = useState("");

  // Vinduet: denne maaned og 11 tilbage. Aeldre maaneder er afregnet for laengst, og
  // en liste uden ende inviterer til at rode i noget, ingen kan lave om paa alligevel.
  const nyeste = nu.getFullYear() * 12 + nu.getMonth();
  const valgt = aar * 12 + (maaned - 1);
  const kanFrem = valgt < nyeste;
  const kanTilbage = valgt > nyeste - 11;

  function skift(retning) {
    const n = valgt + retning;
    if (n > nyeste || n < nyeste - 11) return;
    setAar(Math.floor(n / 12));
    setMaaned((n % 12) + 1);
  }

  useEffect(() => {
    let afbrudt = false;
    (async () => {
      setHenter(true); setFejl("");
      const [t, k] = await Promise.all([
        supabaseClient.rpc("mine_timer", { p_aar: aar, p_maaned: maaned, p_emp: visEmpId || null }),
        supabaseClient.rpc("mine_km",    { p_aar: aar, p_maaned: maaned, p_emp: visEmpId || null }),
      ]);
      if (afbrudt) return;
      // Fejlen maa ikke kastes vaek. En tom liste og "kunne ikke hente" ser ens ud for
      // brugeren, og her betyder forskellen "du har ingen timer" mod "vi ved det ikke"
      // — paa en side der handler om hendes loen.
      if (t.error || k.error) {
        setFejl((t.error || k.error).message);
        setTimer([]); setKm([]);
      } else {
        setTimer(t.data || []);
        setKm(k.data || []);
      }
      setHenter(false);
    })();
    return () => { afbrudt = true; };
  }, [aar, maaned, supabaseClient, visEmpId]);

  // Summerne. Godkendt regnes af de linjer der HAR flueben — ikke af alt.
  const sum = timer.reduce((a, r) => ({
    planlagt:  a.planlagt + (r.planlagt || 0),
    registreret: a.registreret + (r.registreret || 0),
    godkendt:  a.godkendt + (r.godkendt ? (r.registreret || 0) : 0),
    weekend:   a.weekend + (r.weekend ? (r.registreret || 0) : 0),
  }), { planlagt: 0, registreret: 0, godkendt: 0, weekend: 0 });
  const afventer = sum.registreret - sum.godkendt;
  const manglerTid = timer.filter((r) => (r.registreret || 0) === 0).length;

  const kmIalt = km.reduce((s, r) => s + (Number(r.km) || 0), 0);
  const kmGodkendt = km.reduce((s, r) => s + (r.godkendt ? (Number(r.km) || 0) : 0), 0);

  const kmDage = [];
  km.forEach((r) => {
    const sidste = kmDage[kmDage.length - 1];
    if (sidste && sidste.dato === r.dato) sidste.ture.push(r);
    else kmDage.push({ dato: r.dato, ture: [r] });
  });

  const dagTekst = (iso) => new Date(iso + "T12:00:00")
    .toLocaleDateString(da ? "da-DK" : "en-GB",
      { weekday: "short", day: "numeric", month: "short" });

  const kort = (etiket, vaerdi, farve, bag) => (
    <div style={{ background: bag || "#F8FAFC", borderRadius: 10, padding: "10px 8px", minWidth: 0 }}>
      <div style={{ fontSize: 11, color: farve || "#64748B", marginBottom: 3,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{etiket}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: farve || "#111111" }}>{vaerdi}</div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 50,
                  display: "flex", flexDirection: "column" }}>
      {/* env(safe-area-inset-top): siden fylder hele skaermen, og uden den laegger
          overskriften sig ind under statuslinjen paa iPhone. Paa Android er tallet nul. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "calc(14px + env(safe-area-inset-top)) 16px 12px",
                    borderBottom: "1px solid #F1F5F9", flexShrink: 0 }}>
        {/* Navnet i overskriften, ikke «Min». Siden ligger over hele skaermen, saa
            baanderet ude i planen om at man ser en kollega er skjult imens — og saa
            ville kontoret sidde og kigge paa hendes timer under overskriften «Min
            tid». Det er den slags, der bliver til en forkert besked til en
            medarbejder. */}
        <div style={{ fontWeight: 700, fontSize: 17, minWidth: 0, paddingRight: 10,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {anden
            ? (medSolsikke(visEmpNavn, visEmpId) || (da ? "Kollegas tid og kørsel" : "Colleague's time and driving"))
            : (da ? "Min tid og kørsel" : "My time and driving")}
        </div>
        <button onClick={onClose} aria-label={da ? "Luk" : "Close"}
          style={{ border: "none", background: "#F1F5F9", borderRadius: 8, width: 34, height: 34,
                   display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <X size={17} />
        </button>
      </div>

      {anden && (
        <div style={{ background: "#FFF7ED", borderLeft: "4px solid #C2410C", color: "#9A3412",
                      padding: "9px 14px", fontSize: 12.5, lineHeight: 1.45, flexShrink: 0 }}>
          {da ? "Du ser en kollegas tal. Kun visning."
              : "You are viewing a colleague's figures. View only."}
        </div>
      )}

      <div style={{ display: "flex", borderBottom: "1px solid #F1F5F9", padding: "0 16px", flexShrink: 0 }}>
        {[["timer", da ? "Timer" : "Hours"], ["km", da ? "Kørsel" : "Driving"]].map(([k, l]) => (
          <button key={k} onClick={() => setFane(k)}
            style={{ padding: "10px 0", marginRight: 22, border: "none", background: "transparent",
                     fontSize: 14, fontFamily: "inherit", cursor: "pointer",
                     fontWeight: fane === k ? 700 : 500,
                     color: fane === k ? "#D6247A" : "#94A3B8",
                     borderBottom: fane === k ? "2.5px solid #D6247A" : "2.5px solid transparent" }}>
            {l}
          </button>
        ))}
      </div>

      {/* Maanedsvaelgeren. Pilene forsvinder ikke i enderne — de bliver blege og
          reagerer ikke. En knap der pludselig er vaek flytter alt ved siden af. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 16px", borderBottom: "1px solid #F1F5F9", flexShrink: 0 }}>
        <button onClick={() => skift(-1)} disabled={!kanTilbage}
          aria-label={da ? "Forrige måned" : "Previous month"}
          style={{ border: "none", background: "transparent", padding: 6, cursor: kanTilbage ? "pointer" : "default",
                   opacity: kanTilbage ? 1 : 0.25, display: "flex" }}>
          <ChevronLeft size={20} color="#475569" />
        </button>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>
          {(da ? MDR_DA : MDR_EN)[maaned - 1]} {aar}
        </div>
        <button onClick={() => skift(1)} disabled={!kanFrem}
          aria-label={da ? "Næste måned" : "Next month"}
          style={{ border: "none", background: "transparent", padding: 6, cursor: kanFrem ? "pointer" : "default",
                   opacity: kanFrem ? 1 : 0.25, display: "flex" }}>
          <ChevronRight size={20} color="#475569" />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto",
                    padding: "14px 16px calc(28px + env(safe-area-inset-bottom))" }}>
        {henter && <div style={{ color: "#94A3B8", padding: 20, textAlign: "center" }}>
          {da ? "Henter…" : "Loading…"}</div>}

        {!henter && fejl && (
          <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 10,
                        padding: "12px 14px", fontSize: 13.5, lineHeight: 1.5 }}>
            {da ? "Tallene kunne ikke hentes. Prøv igen, når du har dækning."
                : "The figures could not be loaded. Try again when you have coverage."}
          </div>
        )}

        {!henter && !fejl && fane === "timer" && (
          timer.length === 0 ? (
            <div style={{ color: "#94A3B8", padding: 30, textAlign: "center", fontSize: 14 }}>
              {da ? "Ingen opgaver i denne måned." : "No jobs this month."}
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                {kort(da ? "Planlagt" : "Planned", timerTekst(sum.planlagt, da))}
                {kort(da ? "Registreret" : "Logged", timerTekst(sum.registreret, da))}
                {kort(da ? "Til løn" : "To payroll", timerTekst(sum.godkendt, da), "#15803D", "#F0FDF4")}
              </div>

              {afventer > 0 && (
                <div style={{ display: "flex", gap: 9, background: "#FEF3C7", borderRadius: 10,
                              padding: "11px 13px", marginTop: 10 }}>
                  <Clock size={16} color="#92400E" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12.5, color: "#92400E", lineHeight: 1.5 }}>
                    {da
                      ? `${timerTekst(afventer, da)} timer venter stadig på kontorets godkendelse. Kun godkendte timer kommer med på lønsedlen.`
                      : `${timerTekst(afventer, da)} hours are still awaiting the office's approval. Only approved hours reach your payslip.`}
                  </div>
                </div>
              )}

              {manglerTid > 0 && (
                <div style={{ display: "flex", gap: 9, background: "#FEE2E2", borderRadius: 10,
                              padding: "11px 13px", marginTop: 8 }}>
                  <Clock size={16} color="#991B1B" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ fontSize: 12.5, color: "#991B1B", lineHeight: 1.5 }}>
                    {da
                      ? `${manglerTid} ${manglerTid === 1 ? "opgave mangler" : "opgaver mangler"} tid. Uden registreret tid bliver der ikke udbetalt for dem.`
                      : `${manglerTid} ${manglerTid === 1 ? "job is" : "jobs are"} missing time. Without logged time they are not paid.`}
                  </div>
                </div>
              )}

              {sum.weekend > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5,
                              color: "#64748B", padding: "12px 2px 6px" }}>
                  <span>{da ? "Heraf weekend" : "Of which weekend"}</span>
                  <span style={{ color: "#111111", fontWeight: 600 }}>
                    {timerTekst(sum.weekend, da)} {da ? "timer" : "hours"}
                  </span>
                </div>
              )}

              <div style={{ borderTop: "1px solid #F1F5F9", marginTop: 6 }}>
                {timer.map((r) => {
                  const ingen = (r.registreret || 0) === 0;
                  return (
                    <div key={r.opgave_id}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                               gap: 10, padding: "10px 0", borderBottom: "1px solid #F1F5F9" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, color: "#111111" }}>{dagTekst(r.dato)}</div>
                        <div style={{ fontSize: 11.5, color: "#94A3B8", whiteSpace: "nowrap",
                                      overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.hvor || r.titel}{r.weekend ? (da ? " · weekend" : " · weekend") : ""}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div style={{ fontSize: 13.5, color: "#111111" }}>
                          <span style={{ color: "#94A3B8" }}>{timerTekst(r.planlagt, da)}</span>
                          {" → "}
                          {ingen ? <span style={{ color: "#DC2626" }}>—</span>
                                 : timerTekst(r.registreret, da)}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700,
                                      color: ingen ? "#DC2626" : r.godkendt ? "#15803D" : "#B45309" }}>
                          {ingen ? (da ? "Ingen tid registreret" : "No time logged")
                                 : r.godkendt ? (da ? "Godkendt" : "Approved")
                                              : (da ? "Afventer kontoret" : "Awaiting office")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )
        )}

        {!henter && !fejl && fane === "km" && (
          km.length === 0 ? (
            <div style={{ color: "#94A3B8", padding: 30, textAlign: "center", fontSize: 14 }}>
              {da ? "Ingen kørsel i denne måned." : "No driving this month."}
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                {kort(da ? "Kørt i alt" : "Driven in total", kmIalt.toFixed(1).replace(".", da ? "," : ".") + " km")}
                {kort(da ? "Til løn" : "To payroll",
                      kmGodkendt.toFixed(1).replace(".", da ? "," : ".") + " km", "#15803D", "#F0FDF4")}
              </div>
              <div style={{ fontSize: 11.5, color: "#94A3B8", padding: "10px 2px 4px", lineHeight: 1.5 }}>
                {da ? "Satsen pr. kilometer sættes i lønsystemet, ikke her."
                    : "The rate per kilometre is set in the payroll system, not here."}
              </div>

              {kmDage.map((d) => {
                const dagIalt = d.ture.reduce((s, r) => s + (Number(r.km) || 0), 0);
                return (
                  <div key={d.dato} style={{ marginTop: 12, border: "1px solid #F1F5F9",
                                             borderRadius: 12, overflow: "hidden" }}>
                    <div style={{ display: "flex", justifyContent: "space-between",
                                  padding: "9px 13px", background: "#F8FAFC" }}>
                      <span style={{ fontWeight: 700, fontSize: 12.5 }}>{dagTekst(d.dato)}</span>
                      <span style={{ fontWeight: 700, fontSize: 12.5, color: "#4F46E5" }}>
                        {dagIalt.toFixed(1).replace(".", da ? "," : ".")} km
                      </span>
                    </div>
                    {d.ture.map((r, i) => (
                      <div key={r.linje_id}
                        style={{ padding: "9px 13px", fontSize: 12.5,
                                 borderTop: i > 0 ? "1px solid #F1F5F9" : "none" }}>
                        <div style={{ color: "#111111" }}>{r.fra} → {r.til}</div>
                        <div style={{ display: "flex", justifyContent: "space-between",
                                      color: "#94A3B8", fontSize: 11.5, marginTop: 2 }}>
                          <span>
                            {r.km != null ? Number(r.km).toFixed(1).replace(".", da ? "," : ".") + " km" : "—"}
                            {r.minutter != null ? " · " + r.minutter + " min" : ""}
                          </span>
                          <span style={{ fontWeight: 700, color: r.godkendt ? "#15803D" : "#B45309" }}>
                            {r.godkendt ? (da ? "Godkendt" : "Approved")
                                        : (da ? "Afventer" : "Awaiting")}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )
        )}
      </div>
    </div>
  );
}

