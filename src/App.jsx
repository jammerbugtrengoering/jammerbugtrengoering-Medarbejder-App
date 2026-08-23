import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import {
  Clock, CheckCircle2, Video, Lock, ListChecks, Check,
  Navigation, Building2, Car, LogOut, ChevronLeft, ChevronRight,
  X, MapPin,
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
    accessHint: "Nøglebokskoder og alarmkoder er skjult. Når du åbner dem, registreres det med dit navn og tidspunkt.",
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
    finishKmNote: "Din kørsel bliver beregnet i nat, nu hvor tiden er registreret.",
    nexusQ: "Husk at kvittere i Nexus",
    nexusHint: "Kommunen betaler efter det der står i Nexus — ikke efter det du skriver her.",
    nexusOpenNow: "Åbn Nexus nu",
    nexusConfirm: "Ja, jeg har kvitteret i Nexus",
    nexusSkipNote: "Kom du ikke i Nexus? Sæt ikke flueben — så følger kontoret op. Du kan godt afslutte alligevel.",
    nexusDone: "kvitteret",
    nexusMissing: "mangler",
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
    accessHint: "Key box and alarm codes are hidden. When you open them, it is recorded with your name and the time.",
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
    finishKmNote: "Your mileage will be calculated tonight, now that the time is logged.",
    nexusQ: "Remember to sign off in Nexus",
    nexusHint: "The municipality pays according to Nexus — not according to what you write here.",
    nexusOpenNow: "Open Nexus now",
    nexusConfirm: "Yes, I have signed off in Nexus",
    nexusSkipNote: "Could not get into Nexus? Leave it unticked — the office will follow up. You can still finish.",
    nexusDone: "signed off",
    nexusMissing: "missing",
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
// Beregner både ISO-ugenummer OG det år ugen hører til. Omkring årsskiftet kan
// de to afvige (30. dec. kan høre til uge 1 i det nye år), og da planlæggeren
// gemmer både week og year på hver opgave, SKAL vi matche på begge — ellers
// blandes fx uge 30 i 2026 sammen med uge 30 i 2027.
function isoWeekInfo(date) {
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
function weekInfoWithOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset * 7);
  return isoWeekInfo(d);
}
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

// ── Language selector ─────────────────────────────────────────────────────────

// ── Hjælpeside ────────────────────────────────────────────────────────────────
// Samme indhold som den trykte brugervejledning, men bygget til telefon:
// fuld skærm, store trykflader og korte afsnit man kan skimme med én hånd.
const HELP_DA = [
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
      "Skal det rettes, er der to rækker med − og + : øverst timer, nederst minutter. Minutterne går i spring af 5.",
      "Det store tal foroven er det du registrerer i alt. Under det står om det passer med det planlagte.",
      "Brugte du længere tid end afsat, skal du skrive hvorfor. Det er ikke en løftet pegefinger — kontoret skal kunne forklare det til kunden.",
      "Har du fortrudt en afslutning og åbner opgaven igen — fx for at tilføje et billede — står der 0, og det er helt i orden. Din tid er registreret i forvejen, og du skal ikke taste mere for at komme videre." ] },
  { t: "Produkter til kunden", p: [
      "Produkter henter du på kontoret. Planlæggeren skriver ned hvad du har fået med, og til hvilken kunde. Du skal ikke selv vælge noget i appen.",
      "Har du varer med til en kunde, kommer der et ekstra trin når du afslutter en opgave hos netop den kunde. Der står hvad du fik med, og du svarer ja eller nej til om kunden har fået det.",
      "Det er lige meget hvilken opgave hos kunden du står på — udleveringen følger dig og kunden, ikke en bestemt dag. Bliver opgaven flyttet, følger den med.",
      "Siger du nej, bliver varerne stående hos dig og dukker op igen næste gang du er hos kunden. Kunden får først en regning for dem når du har sagt ja.",
      "Bliver du ikke spurgt, har du ingen varer med til den kunde. Så er der ét trin mindre, og tælleren øverst siger fx «1 af 2»." ] },
  { t: "Nexus-borgere", p: [
      "Er opgaven hos en Nexus-borger, står det øverst på opgaven, og der er en knap til at åbne KMD Nexus.",
      "Når du afslutter, kommer der et ekstra trin hvor du bliver mindet om at kvittere i Nexus. Kommunen betaler efter det der står i Nexus — ikke efter det du skriver her.",
      "Har du kvitteret, sætter du fluebenet. Kunne du ikke komme i Nexus, så lad det stå tomt — du kan afslutte alligevel, og kontoret følger op." ] },
  { t: "Bestil arbejdstøj", p: [
      "Tryk på trøje-ikonet 👕 øverst.",
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
      "Tryk på kalender-ikonet 📅 øverst for at booke et kundemøde. Kunden behøver ikke findes i Dinero endnu.",
      "Mødet lægges i din uge, så kontoret kan se at du er ude, og tiden tæller i din kapacitet.",
      "Åbn mødet når du er derude. Du får tilbudsskærmen i stedet for den almindelige opgave: referat, billeder, pris og hvilke ydelser der er med.",
      "Referatet er lavet til at blive dikteret. Tryk på mikrofonen på tastaturet og tal — ret det bagefter.",
      "Du kan lægge op til 10 billeder på. De er interne, medmindre du på tilbuddet vælger at vise dem til kunden.",
      "«Send til kunden» danner PDF'en og mailer et link hun kan acceptere fra. Accepterer hun, dannes aftalen som kladde — du sætter selv startdato og ugedage." ] },
  { t: "Din kørsel", p: [
      "Tryk på bil-ikonet 🚗 øverst for at se din beregnede kørsel.",
      "Du skal ikke selv taste kilometer — det regnes ud fra dine opgaver, når du har registreret din tid.",
      "Har du kørsel med i din arbejdstid, står der «Kørsel hjemmefra» øverst på dagen og «Kørsel hjem» nederst. Klokkeslættet øverst er altså hvornår du tager hjemmefra, ikke hvornår du skal være hos den første kunde.",
      "Ser du ikke de to linjer, er du ikke på den ordning, og din kørsel afregnes med kilometerpenge i stedet. Spørg kontoret hvis du er i tvivl om hvad der gælder for dig." ] },
  { t: "Hvis noget driller", p: [
      "Kan du ikke logge ind? Tjek din e-mail og brug «Glemt adgangskode?».",
      "Kan du ikke se dine opgaver? Tjek at du står på den rigtige uge og dag.",
      "Mangler der en opgave? Kontakt kontoret — de kan flytte den.",
      "Hænger appen? Luk siden og åbn den igen." ] },
];
const HELP_EN = [
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
      "To change it, use the two rows of − and + : hours on top, minutes below. Minutes move in steps of 5.",
      "The large number at the top is the total you are registering. Below it you can see whether it matches the plan.",
      "If it took longer than planned, you need to write why. It is not a telling-off — the office has to be able to explain it to the customer.",
      "If you undid a completion and open the job again — for example to add a photo — it says 0, and that is fine. Your time is already registered, and you do not need to enter more to continue." ] },
  { t: "Products for the customer", p: [
      "You pick up products at the office. The planner records what you were given, and for which customer. You do not select anything in the app yourself.",
      "If you are carrying items for a customer, an extra step appears when you complete a job for that customer. It shows what you were given, and you answer yes or no to whether the customer received it.",
      "It does not matter which job for that customer you are on — the handover follows you and the customer, not a particular day. If the job is moved, it comes along.",
      "If you say no, the items stay with you and show up again next time you visit that customer. The customer is only invoiced once you say yes.",
      "If you are not asked, you have nothing for that customer. Then there is one step fewer, and the counter at the top says for example \"1 of 2\"." ] },
  { t: "Nexus citizens", p: [
      "If the job is for a Nexus citizen, it says so at the top of the job, and there is a button to open KMD Nexus.",
      "When you complete the job there is an extra step reminding you to sign off in Nexus. The municipality pays according to Nexus — not according to what you write here.",
      "If you have signed off, tick the box. If you could not get into Nexus, leave it empty — you can still finish, and the office will follow up." ] },
  { t: "Order workwear", p: [
      "Tap the shirt icon 👕 at the top.",
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
      "Tap the calendar icon 📅 at the top to book a customer meeting. The customer does not have to exist in Dinero yet.",
      "The meeting goes into your week, so the office can see you are out, and the time counts in your capacity.",
      "Open the meeting once you are there. You get the quote screen instead of the ordinary job: notes, photos, price and which services are included.",
      "The notes field is made for dictation. Tap the microphone on the keyboard and speak — edit it afterwards.",
      "You can add up to 10 photos. They are internal unless you choose to show them to the customer on the quote.",
      "\"Send to customer\" creates the PDF and mails a link she can accept from. If she accepts, the agreement is created as a draft — you set the start date and weekdays yourself." ] },
  { t: "Your mileage", p: [
      "If travel is part of your working hours, the day starts with \"Travel from home\" and ends with \"Travel home\". The time at the top is when you leave home, not when you must be at the first customer.",
      "If you do not see those two lines, you are not on that arrangement, and your driving is paid as mileage instead. Ask the office if you are unsure what applies to you.",
      "Tap the car icon 🚗 at the top to see your calculated mileage.",
      "You do not enter kilometres yourself — it is calculated from your jobs once you register your time." ] },
  { t: "If something goes wrong", p: [
      "Cannot log in? Check your email and use \"Forgot password?\".",
      "Cannot see your jobs? Check you are on the right week and day.",
      "A job is missing? Contact the office — they can move it.",
      "App stuck? Close the page and open it again." ] },
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
function HelpPage({ lang, onClose }) {
  const da = lang === "da";
  const sections = da ? HELP_DA : HELP_EN;
  return (
    <div style={{ position:"fixed", inset:0, background:"#fff", zIndex:120, display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"14px 16px", borderBottom:"1px solid #E2E8F0", background:"#111", color:"#fff" }}>
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
      <div style={{ flex:1, overflowY:"auto", padding:"14px 16px 32px", WebkitOverflowScrolling:"touch",
                    textAlign:"left", maxWidth:640, margin:"0 auto", width:"100%", boxSizing:"border-box" }}>
        <div style={{ background:"#FCE4EF", borderRadius:10, padding:"12px 14px", marginBottom:16,
                      fontSize:14.5, lineHeight:1.5, color:"#9C1B5D", fontWeight:700 }}>
          {da ? "Hver dag: åbn appen → tryk på opgaven → sæt flueben → registrér tid → marker som udført."
              : "Every day: open the app → tap the job → tick off tasks → register time → mark as done."}
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
      <div style={s.sheet}><div style={{ padding: 40, textAlign: "center", color: "#94A3B8" }}>Indlæser…</div></div>
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
      <div style={s.sheet}>
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
            <option value="aeldrelov">Ældreloven</option>
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
        <div style={s.sheet}>
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
      <div style={s.sheet}>
        <div style={s.afslutTop}>
          <button style={s.afslutTilbage} onClick={() => (art ? setArt(null) : onAfbryd())}>
            <ChevronLeft size={16} /> {tr.back}
          </button>
          <span>{task.customerName || ""}</span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "18px 16px 20px" }}>
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
function AfslutOpgave({ task, employee, lang, tr, supabaseClient, onLogMinutes, onSetStatus, onAfbryd, onFaerdig }) {
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
  const minEgenTid = task.duration || 0;
  const planlagt = minEgenTid * antalPaa;
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
  const [samletMin, setSamletMin] = useState(
    Math.round(Math.max(0, minEgenTid - migLoggede) / 5) * 5,
  );
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
  function skift(delta) {
    setFejl("");
    setSamletMin((v) => Math.max(0, Math.min(12 * 60, v + delta)));
  }

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
      if (erNexus) {
        const { error: nxErr } = await supabaseClient
          .from("instances").update({ nexus_confirmed: nexusOk }).eq("id", task.id);
        if (nxErr && !erNetvaerksfejl(nxErr)) throw new Error(nxErr.message);
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
        <div style={s.sheet}>
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
        <div style={s.sheet}>
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
            <button style={s.primaerStor} onClick={onFaerdig}>{tr.finishNext}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.overlay} onClick={(e) => e.stopPropagation()}>
      <div style={s.sheet}>
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

              <div style={{ marginTop: 16 }}>
                <div style={s.stepperLabel}>{tr.finishHours}</div>
                <div style={s.stepperRaekke}>
                  <button style={s.stepperBtn} onClick={() => skift(-60)} aria-label="minus">−</button>
                  <div style={s.stepperTal}>{timer}</div>
                  <button style={s.stepperBtn} onClick={() => skift(60)} aria-label="plus">+</button>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={s.stepperLabel}>{tr.finishMinutes}</div>
                <div style={s.stepperRaekke}>
                  <button style={s.stepperBtn} onClick={() => skift(-5)} aria-label="minus">−</button>
                  <div style={s.stepperTal}>{String(minutter).padStart(2, "0")}</div>
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
function TaskModal({ task, employee, lang, onClose, onLogMinutes, onSetStatus, onToggleChecklist, supabaseClient }) {
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
              foer hun trykker, ikke opdage det bagefter. */}
          <div style={s.sheetSection}>
            <div style={s.sheetSectionTitle}><Lock size={14} /> {tr.access}</div>
            {adgangTekst !== null ? (
              <>
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
  return (
    <div style={{ ...s.taskCard, opacity: done ? 0.7 : 1 }} onClick={onClick}>
      <div style={{ ...s.taskAccent, background: done ? "#22C55E" : inProgress ? "#F59E0B" : "#D6247A" }} />
      <div style={s.taskBody}>
        <div style={s.taskTime}>{fmtClock(seg.start)}</div>
        <div style={s.taskTitle}>{translatedTitle}</div>
        {t.customerName && (
          <div style={s.taskCustomer}>
            <Building2 size={12} color="#9C1B5D" />
            <span>{t.customerName}</span>
            {t.contractType === "nexus" && <span style={{ fontSize:10, fontWeight:700, color:"#4F46E5", background:"#EEF2FF", borderRadius:6, padding:"1px 6px", marginLeft:4 }}>Nexus</span>}
            {t.contractType === "privat" && <span style={{ fontSize:10, fontWeight:700, color:"#9C1B5D", background:"#FFF6FA", borderRadius:6, padding:"1px 6px", marginLeft:4 }}>{lang === "da" ? "Privat" : "Private"}</span>}
            {t.contractType === "aeldrelov" && <span style={{ fontSize:10, fontWeight:700, color:"#C2410C", background:"#FFF7ED", borderRadius:6, padding:"1px 6px", marginLeft:4 }}>Ældrelov</span>}
          </div>
        )}
        {t.address && (
          <div style={s.taskAddress}>
            <MapPin size={11} color="#94A3B8" />
            <span>{t.address}</span>
          </div>
        )}
        {/* Noeglen skal hentes paa kontoret. Staar paa selve kortet i dagslisten, ikke
            inde i opgaven — hun skal se det inden hun koerer, ikke naar hun staar der. */}
        {t.needsKeyPickup && (
          <div style={s.noegleMaerke}>🔑 {lang === "da" ? "Hent nøgle/adgangskort på kontoret" : "Pick up key or access card at the office"}</div>
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

export default function MedarbejderApp() {
  // Dansk som udgangspunkt. Alle 20 medarbejdere staar med dansk i databasen, men
  // profilen hentes foerst efter foerste render — med "en" som standard blinkede
  // appen paa engelsk hver gang den blev aabnet.
  const [lang, setLang] = useState(() => localStorage.getItem("wl_lang") || "da");
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
    (async () => {
      try {
        const { registerSW } = await import("virtual:pwa-register");
        opdater = registerSW({
          onNeedRefresh() { setNyVersion(() => opdater); },
          onRegisteredSW(_url, reg) {
            // Tjek en gang i timen. En telefon der ligger aaben hele dagen ville ellers
            // foerst opdage en rettelse naeste gang appen blev lukket helt ned.
            if (reg) setInterval(() => reg.update(), 60 * 60 * 1000);
          },
        });
      } catch {
        // I udviklingstilstand findes modulet ikke. Det er i orden — saa er der ingen
        // service worker, og appen henter alt friskt hver gang.
      }
    })();
  }, []);

  // Persist lang change to employee row in DB
  async function changeLang(newLang) {
    setLang(newLang);
    if (employee) {
      await supabase.from("employees").update({ default_lang: newLang }).eq("id", employee.id);
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
  const [showHelp, setShowHelp] = useState(false);
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
          if (kopi.travelSettings) setTravelSettings(kopi.travelSettings);
          setKopiHentet(kopi.hentet);
          setDataLoading(false);
          return;
        }
        setIngenForbindelse(true);
        setDataLoading(false);
        return;
      }
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

      // Apply saved language preference
      if (empData.default_lang && empData.default_lang !== lang) {
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
            customerName: i.customer_name || "",
            address: i.address_text || "",
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

  if (!employee) return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={s.errorBox}>{tr.noProfileError}</div>
        <button style={s.loginBtn} onClick={signOut}>{tr.signOut}</button>
      </div>
    </div>
  );

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
          <div>
            <div style={s.headerTitle}>{tr.appName}</div>
            <div style={s.headerSub}>
              {tr.week} {currentWeek}
              {/* Hvilken udgave koerer der? Med en service worker imellem kan man
                  ikke se udefra om en rettelse er naaet frem, og saa tester man
                  gammel kode uden at vide det. */}
              <span style={{ opacity: 0.55, marginLeft: 8 }}>v{typeof __BYGGET__ === "string" ? __BYGGET__ : "?"}</span>
            </div>
          </div>
        </div>
        <div style={s.headerRight}>
          <LangToggle lang={lang} setLang={changeLang} />
          {/* Kun planlaeggere. Rengoeringsdamerne skal ikke have en knap de aldrig
              skal bruge — og databasen afviser kaldet uanset hvad. */}
          {employee?.is_admin && (
            <button
              style={{ border:"none", background:"#F0FDFA", color:"#0F766E", borderRadius:8, padding:"6px 10px", fontSize:12, fontWeight:700, cursor:"pointer" }}
              onClick={() => setNytMoede(true)}
              title={lang === "da" ? "Nyt kundemøde" : "New customer meeting"}>
              📅
            </button>
          )}
          <button
            style={{ border:"none", background:"#FCE4EF", color:"#D6247A", borderRadius:8, padding:"6px 10px", fontSize:12, fontWeight:700, cursor:"pointer" }}
            onClick={() => setShowShop(true)}
            title={lang === "da" ? "Bestil medarbejderprodukter" : "Order staff products"}>
            👕
          </button>
          <button
            style={{ border:"none", background:"#EEF2FF", color:"#4F46E5", borderRadius:8, padding:"6px 10px", fontSize:12, fontWeight:700, cursor:"pointer" }}
            onClick={() => setShowKm(true)}
            title={lang === "da" ? "Min kørsel" : "My driving"}>
            🚗
          </button>
          <button
            style={{ border:"none", background:"#F1F5F9", color:"#334155", borderRadius:8, padding:"6px 11px", fontSize:13, fontWeight:800, cursor:"pointer" }}
            onClick={() => setShowHelp(true)}
            title={lang === "da" ? "Hjælp - sådan bruger du appen" : "Help - how to use the app"}>
            ?
          </button>
          <button
            style={{ ...s.signOutBtn, display:"flex", alignItems:"center", gap:6, color:"#E2E8F0", fontSize:13, fontWeight:600 }}
            onClick={() => setShowProfile((v) => !v)}>
            <span style={{ width:28, height:28, borderRadius:"50%", background:"#D6247A", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#fff", flexShrink:0 }}>
              {employee.name.split(" ").map((n) => n[0]).join("").slice(0,2).toUpperCase()}
            </span>
          </button>
        </div>
      </div>

      {/* Profile panel */}
      {showProfile && (
        <div style={s.profilePanel}>
          <div style={s.profileHeader}>
            <div style={{ width:44, height:44, borderRadius:"50%", background:"#D6247A", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, color:"#fff" }}>
              {employee.name.split(" ").map((n) => n[0]).join("").slice(0,2).toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight:700, fontSize:16, color:"#111111" }}>{employee.name}</div>
              <div style={{ fontSize:13, color:"#64748B" }}>{session?.user?.email}</div>
            </div>
          </div>

          {/* Language */}
          <div style={s.profileSection}>
            <div style={s.profileLabel}>🌐 {lang === "da" ? "Sprog / Language" : "Language / Sprog"}</div>
            <div style={{ display:"flex", gap:8 }}>
              <button
                style={{ flex:1, padding:"10px 0", borderRadius:10, border: lang==="da" ? "2px solid #D6247A" : "1.5px solid #E2E8F0", background: lang==="da" ? "#FCE4EF" : "#fff", color: lang==="da" ? "#D6247A" : "#475569", fontWeight:700, fontSize:14, cursor:"pointer" }}
                onClick={() => changeLang("da")}>🇩🇰 Dansk</button>
              <button
                style={{ flex:1, padding:"10px 0", borderRadius:10, border: lang==="en" ? "2px solid #D6247A" : "1.5px solid #E2E8F0", background: lang==="en" ? "#FCE4EF" : "#fff", color: lang==="en" ? "#D6247A" : "#475569", fontWeight:700, fontSize:14, cursor:"pointer" }}
                onClick={() => changeLang("en")}>🇬🇧 English</button>
            </div>
            <div style={{ fontSize:11, color:"#94A3B8", marginTop:4 }}>
              {lang === "da" ? "Dit sprogvalg gemmes til næste gang" : "Your language preference is saved"}
            </div>
          </div>

          {/* Password reset */}
          <div style={s.profileSection}>
            <div style={s.profileLabel}>🔑 {lang === "da" ? "Adgangskode" : "Password"}</div>
            {resetSent ? (
              <div style={{ fontSize:13, color:"#16A34A", background:"#ECFDF5", padding:"10px 12px", borderRadius:10 }}>
                ✓ {lang === "da" ? "Link til nulstilling sendt til" : "Reset link sent to"} {session?.user?.email}
              </div>
            ) : (
              <button
                style={{ width:"100%", padding:"11px 0", borderRadius:10, border:"1.5px solid #E2E8F0", background:"#fff", color:"#475569", fontWeight:600, fontSize:14, cursor:"pointer" }}
                onClick={sendPasswordReset} disabled={resetLoading}>
                {resetLoading ? "Sender…" : (lang === "da" ? "Send nulstillingslink til min mail" : "Send password reset to my email")}
              </button>
            )}
          </div>

          {/* Sign out */}
          <a
            href={`https://translate.google.com/translate?sl=da&tl=en&u=${encodeURIComponent(window.location.href)}`}
            target="_blank" rel="noreferrer"
            style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, width:"100%", padding:"11px 0", borderRadius:12, border:"1.5px solid #E2E8F0", background:"#fff", color:"#475569", fontWeight:600, fontSize:14, textDecoration:"none" }}>
            🌐 {lang === "da" ? "Oversæt siden til engelsk" : "Translate page to Danish"}
          </a>
          <button
            style={{ width:"100%", padding:"13px 0", borderRadius:12, border:"none", background:"#FEF2F2", color:"#DC2626", fontWeight:700, fontSize:15, cursor:"pointer" }}
            onClick={signOut}>
            {tr.signOut}
          </button>
        </div>
      )}

      {/* Medarbejdervælger — kun for administratorer, og kun på computer.
          Man starter altid på sin egen plan; det her er noget man aktivt vælger. */}
      {allEmployees.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#64748B" }}>Se plan for</span>
          <select
            value={viewEmpId || ""}
            onChange={(e) => setViewEmpId(e.target.value || null)}
            style={{ padding: "6px 10px", fontSize: 13, borderRadius: 8, border: "1px solid #CBD5E1", background: "#fff" }}>
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

        {schedule.map((seg) => {
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

      {showHelp && <HelpPage lang={lang} onClose={() => setShowHelp(false)} />}

      {showKm && (
        <KmPage
          employee={employee}
          lang={lang}
          supabaseClient={supabase}
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
          onLuk={() => setOpenTask(null)}
        />
      )}

      {openTask && openTask.type !== "aktivitet" && (
        <TaskModal
          key={openTask.id}
          task={instances.find((t) => t.id === openTask.id) || openTask}
          employee={employee}
          lang={lang}
          onClose={() => setOpenTask(null)}
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

  header: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", background:"#111111" },
  headerLeft: { display:"flex", alignItems:"center", gap:10 },
  headerRight: { display:"flex", alignItems:"center", gap:8 },
  headerIcon: { width:34, height:34, borderRadius:8, objectFit:"cover" },
  headerTitle: { fontWeight:700, fontSize:15, color:"#fff" },
  headerSub: { fontSize:11, color:"#94A3B8" },
  signOutBtn: { border:"none", background:"transparent", color:"#64748B", cursor:"pointer", padding:4, display:"flex", alignItems:"center" },

  profilePanel: { background:"#fff", borderBottom:"1px solid #F1F5F9", padding:"20px 16px 16px", display:"flex", flexDirection:"column", gap:16, boxShadow:"0 4px 16px rgba(0,0,0,0.08)" },
  profileHeader: { display:"flex", alignItems:"center", gap:12 },
  profileSection: { display:"flex", flexDirection:"column", gap:8 },
  profileLabel: { fontSize:12, fontWeight:700, color:"#475569", textTransform:"uppercase", letterSpacing:"0.05em" },

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

  taskCard: { display:"flex", alignItems:"stretch", background:"#fff", borderRadius:14, boxShadow:"0 1px 3px rgba(0,0,0,0.06)", cursor:"pointer", overflow:"hidden", border:"1px solid #F1F5F9" },
  taskAccent: { width:4, flexShrink:0 },
  taskBody: { flex:1, padding:"13px 12px", minWidth:0 },
  taskRight: { display:"flex", alignItems:"center", paddingRight:12 },
  taskTime: { fontSize:11.5, fontWeight:700, color:"#D6247A", marginBottom:3 },
  taskTitle: { fontWeight:700, fontSize:15.5, color:"#111111", lineHeight:1.25, marginBottom:5 },
  taskCustomer: { display:"flex", alignItems:"center", gap:5, fontSize:13, color:"#475569", fontWeight:500, marginBottom:6 },
  taskAddress: { display:"flex", alignItems:"center", gap:5, fontSize:11.5, color:"#94A3B8", fontWeight:500, marginBottom:6, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  taskMeta: { display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" },
  taskDuration: { fontSize:12, color:"#64748B", fontWeight:500 },
  taskChecklist: { display:"flex", alignItems:"center", gap:3, fontSize:12, color:"#64748B" },
  taskLogged: { display:"flex", alignItems:"center", gap:3, fontSize:12, color:"#9C1B5D", fontWeight:600 },

  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:1000, display:"flex", alignItems:"stretch" },
  sheet: { width:"100%", height:"100%", maxHeight:"100%", background:"#fff", borderRadius:0, display:"flex", flexDirection:"column", position:"relative" },
  dragHandle: { width:36, height:4, background:"#E2E8F0", borderRadius:99, margin:"12px auto 0" },
  sheetClose: { position:"absolute", top:12, right:14, border:"none", background:"#F1F5F9", borderRadius:99, width:32, height:32, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:"#475569" },
  sheetScroll: { flex:1, overflowY:"auto", padding:"8px 20px 20px" },

  sheetStatusRow: { display:"flex", alignItems:"center", gap:8, marginBottom:6, marginTop:8 },
  statusBadge: { fontSize:12, fontWeight:700, padding:"4px 10px", borderRadius:99 },
  sheetTitle: { fontWeight:800, fontSize:20, color:"#111111", lineHeight:1.25, marginBottom:4 },
  sheetMeta: { fontSize:13, color:"#64748B", marginBottom:16 },
  sheetSection: { marginBottom:20, paddingBottom:20, borderBottom:"1px solid #F1F5F9" },
  sheetSectionTitle: { display:"flex", alignItems:"center", gap:6, fontSize:12, fontWeight:700, color:"#475569", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 },
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
  afslutBund: { borderTop:"1px solid #F1F5F9", padding:"12px 16px 26px", background:"#fff", flexShrink:0 },
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
  tilbudAfsnit: { fontSize:11.5, fontWeight:800, letterSpacing:".05em", textTransform:"uppercase",
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
        reason: lang === "da" ? `Bestilt af ${employee.name}` : `Ordered by ${employee.name}`,
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


function KmPage({ employee, lang, supabaseClient, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { data } = await supabaseClient
        .from("km_log")
        .select("work_date, leg_order, from_address, to_address, km, minutes")
        .eq("employee_id", employee.id)
        .order("work_date", { ascending: false })
        .order("leg_order", { ascending: true })
        .limit(200);
      if (cancelled) return;
      setRows(data || []);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [employee.id]);

  const byDate = {};
  rows.forEach((r) => {
    if (!byDate[r.work_date]) byDate[r.work_date] = [];
    byDate[r.work_date].push(r);
  });
  const dates = Object.keys(byDate).sort((a, b) => (a < b ? 1 : -1));

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 50, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #F1F5F9", position: "sticky", top: 0, background: "#fff" }}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>{lang === "da" ? "Min kørsel" : "My driving"}</div>
        <button onClick={onClose} style={{ border: "none", background: "#F1F5F9", borderRadius: 8, width: 32, height: 32, fontSize: 16, cursor: "pointer" }}>✕</button>
      </div>
      <div style={{ padding: 16 }}>
        {loading && <div style={{ color: "#64748B" }}>{lang === "da" ? "Indlæser..." : "Loading..."}</div>}
        {!loading && dates.length === 0 && (
          <div style={{ color: "#64748B", padding: 20, textAlign: "center" }}>
            {lang === "da" ? "Ingen kørsel registreret endnu." : "No driving registered yet."}
          </div>
        )}
        {!loading && dates.map((d) => {
          const legs = byDate[d];
          const total = legs.reduce((s, r) => s + (Number(r.km) || 0), 0);
          return (
            <div key={d} style={{ marginBottom: 18, border: "1px solid #F1F5F9", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "#F8FAFC" }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{d}</span>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#4F46E5" }}>{total.toFixed(1)} km</span>
              </div>
              {legs.map((r, i) => (
                <div key={i} style={{ padding: "10px 14px", borderTop: i > 0 ? "1px solid #F1F5F9" : "none", fontSize: 13 }}>
                  <div style={{ color: "#111111" }}>{r.from_address} → {r.to_address}</div>
                  <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 2 }}>{r.km != null ? Number(r.km).toFixed(1) + " km" : "—"} {r.minutes != null ? "· " + r.minutes + " min" : ""}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

