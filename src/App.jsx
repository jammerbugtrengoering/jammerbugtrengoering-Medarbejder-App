import React, { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import {
  Clock, CheckCircle2, Video, Lock, ListChecks, Check,
  Navigation, Building2, Car, LogOut, ChevronLeft, ChevronRight,
  X, MapPin,
} from "lucide-react";

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
    minutesPlaceholder: "Antal minutter",
    openNexus: "Åbn KMD Nexus Mobile",
    overrunTitle: "Registreret tid overskrider planlagt tid",
    overrunBody: (reg, plan) => `Med denne registrering bliver der brugt ${reg} på opgaven, men der er kun planlagt ${plan}. Angiv en begrundelse for overskridelsen.`,
    overrunPlaceholder: "Begrundelse for overskridelsen…",
    overrunRequired: "Du skal angive en begrundelse for at registrere tiden.",
    overrunNoteLabel: "Begrundelse",
    logTime: "Registrér tid",
    saving: "Gemmer…",
    markDone: "Marker som udført",
    markNotDone: "Marker som ikke udført",
    status: { planlagt: "Planlagt", i_gang: "I gang", udført: "Udført" },
    taskVideo: "Se video",
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
    minutesPlaceholder: "Number of minutes",
    openNexus: "Open KMD Nexus Mobile",
    overrunTitle: "Registered time exceeds planned time",
    overrunBody: (reg, plan) => `With this entry, ${reg} will have been spent on the task, but only ${plan} is planned. Please state a reason for the overrun.`,
    overrunPlaceholder: "Reason for the overrun…",
    overrunRequired: "You must state a reason to register the time.",
    overrunNoteLabel: "Reason",
    logTime: "Log time",
    saving: "Saving…",
    markDone: "Mark as completed",
    markNotDone: "Mark as not completed",
    status: { planlagt: "Planned", i_gang: "In progress", udført: "Completed" },
    taskVideo: "Watch video",
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
  const [title, accessInstructions, checklist] = await Promise.all([
    translateText(task.title, targetLang),
    translateText(task.accessInstructions, targetLang),
    Promise.all((task.checklist || []).map(async (item) => ({
      ...item,
      text: await translateText(item.text, targetLang),
      description: await translateText(item.description, targetLang),
    }))),
  ]);
  return { ...task, title, accessInstructions, checklist };
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
  const isIOS = /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);

  if (isAndroid) {
    // Android klarer det i ét hop: intent:// starter appen ud fra pakkenavnet hvis
    // den er installeret, og sender ellers browseren til Play Store. Der skal ikke
    // gættes et URL-scheme, så det virker uanset hvad KMD har valgt internt.
    window.location.href =
      `intent://open#Intent;scheme=https;package=${NEXUS_ANDROID_PACKAGE};` +
      `S.browser_fallback_url=${encodeURIComponent(NEXUS_PLAY_STORE_URL)};end`;
    return;
  }

  if (!isIOS) {
    window.open(NEXUS_APP_STORE_URL, "_blank", "noopener");
    return;
  }

  // iOS: forsøg at åbne appen, og gå kun til App Store hvis der ikke skete noget.
  // Timeren annulleres så snart siden mister fokus (= appen kom i forgrunden).
  // Uden det blev brugeren sendt i App Store SELVOM appen åbnede korrekt — det
  // var fejlen i den tidligere version.
  let fallbackTimer = window.setTimeout(() => {
    cleanup();
    window.location.href = NEXUS_APP_STORE_URL;
  }, 1200);

  function cleanup() {
    if (fallbackTimer) { window.clearTimeout(fallbackTimer); fallbackTimer = null; }
    document.removeEventListener("visibilitychange", onLeave);
    window.removeEventListener("pagehide", onLeave);
    window.removeEventListener("blur", onLeave);
  }
  function onLeave() { cleanup(); }

  document.addEventListener("visibilitychange", onLeave);
  window.addEventListener("pagehide", onLeave);
  window.addEventListener("blur", onLeave);

  window.location.href = NEXUS_IOS_SCHEME;
}

function todayKey() {
  const keys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return keys[new Date().getDay()];
}
function todayWorkdayKey() {
  // Returner nærmeste hverdag (til default dag-valg)
  const keys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const k = keys[new Date().getDay()];
  if (k === "Sat") return "Fri";
  if (k === "Sun") return "Mon";
  return k;
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
function computeDaySchedule(dayTasks, settings) {
  let cursor = parseTimeToMinutes(settings.dayStart);
  const segments = [];
  dayTasks.forEach((t, idx) => {
    if (idx > 0) {
      const travel = getTravelMinutes(dayTasks[idx - 1].address, t.address, settings);
      if (travel > 0) {
        segments.push({ type: "transport", minutes: travel, start: cursor, key: `${dayTasks[idx-1].id}->${t.id}`, to: t.address });
        cursor += travel;
      }
    }
    segments.push({ type: "task", task: t, start: cursor });
    cursor += t.duration;
  });
  return segments;
}

// ── Language selector ─────────────────────────────────────────────────────────
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

// ── Product usage page ────────────────────────────────────────────────────────
function ProductPage({ task, employee, lang, onClose, onSave, supabaseClient }) {
  const tr = T[lang];
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      // Hent kun kundeprodukter
      const { data: cats } = await supabaseClient.from("inventory_categories").select("id").eq("type", "kunde");
      const catIds = (cats || []).map((c) => c.id);
      if (!catIds.length) { setLoading(false); return; }
      const { data } = await supabaseClient
        .from("inventory_items")
        .select("*, inventory_categories(name,icon)")
        .in("category_id", catIds)
        .order("name");
      setItems(data || []);
      setLoading(false);
    }
    load();
  }, []);

  async function save() {
    const entries = Object.entries(selected).filter(([, qty]) => Number(qty) > 0);
    if (!entries.length) { onClose(); return; }
    setSaving(true);
    for (const [itemId, qty] of entries) {
      const amount = Number(qty);
      const item = items.find((i) => i.id === itemId);
      if (!item) continue;
      const { error: txErr } = await supabaseClient.from("inventory_transactions").insert({
        item_id: itemId, quantity: -amount, type: "out",
        reason: `Brugt på: ${task.title}`,
        instance_id: task.id, employee_id: employee.id,
      });
      if (txErr) { console.error("inventory_transactions insert:", txErr.message); alert(`Kunne ikke registrere forbrug af "${item.name}" — prøv igen.`); setSaving(false); return; }
      // Atomart fradrag i databasen. Tidligere blev lagertallet læst i browseren,
      // trukket fra og skrevet tilbage — hvis to medarbejdere udtog varer samtidig,
      // overskrev den ene den andens opdatering, og lageret blev forkert.
      const { error: stockErr } = await supabaseClient.rpc("consume_stock", { p_item_id: itemId, p_amount: amount });
      if (stockErr) { console.error("consume_stock:", stockErr.message); alert(`Kunne ikke opdatere lageret for "${item.name}" — prøv igen.`); setSaving(false); return; }
    }
    setSaving(false);
    onSave(entries.map(([id, qty]) => ({ id, qty: Number(qty), name: items.find((i) => i.id === id)?.name })));
  }

  const usedCount = Object.values(selected).filter((v) => Number(v) > 0).length;

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={{ ...s.sheet, maxHeight: "95svh" }} onClick={(e) => e.stopPropagation()}>
        <div style={s.dragHandle} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px 0" }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "#111111" }}>
            📦 {lang === "da" ? "Produkter brugt" : "Products used"}
          </div>
          <button style={s.sheetClose} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 13, color: "#64748B", padding: "4px 20px 12px" }}>{task.title}</div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 20px" }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>Indlæser produkter…</div>
          ) : items.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "#94A3B8" }}>
              {lang === "da" ? "Ingen kundeprodukter på lager" : "No customer products in inventory"}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {items.map((item) => {
                const qty = selected[item.id] || "";
                const hasQty = Number(qty) > 0;
                return (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid #F1F5F9", background: hasQty ? "#FFF6FA" : "transparent", borderRadius: hasQty ? 10 : 0, paddingLeft: hasQty ? 10 : 0, transition: "all 0.15s" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: hasQty ? 700 : 500, color: "#111111" }}>
                        {item.inventory_categories?.icon} {item.name}
                      </div>
                      <div style={{ fontSize: 12, color: "#94A3B8" }}>
                        {lang === "da" ? "Lager" : "Stock"}: {item.stock} {item.unit}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        style={{ width: 32, height: 32, borderRadius: "50%", border: "1.5px solid #E2E8F0", background: "#fff", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#475569" }}
                        onClick={() => setSelected((prev) => ({ ...prev, [item.id]: Math.max(0, (Number(prev[item.id]) || 0) - 1) || "" }))}>−</button>
                      <input
                        type="number" min={0} max={item.stock} step={1} inputMode="numeric" pattern="[0-9]*"
                        style={{ width: 52, padding: "7px 4px", borderRadius: 8, border: hasQty ? "2px solid #D6247A" : "1.5px solid #E2E8F0", fontSize: 15, textAlign: "center", color: "#111111", background: "#fff", fontWeight: hasQty ? 700 : 400 }}
                        value={qty}
                        onChange={(e) => setSelected((prev) => ({ ...prev, [item.id]: e.target.value.replace(/[^0-9]/g, "") }))}
                      />
                      <button
                        style={{ width: 32, height: 32, borderRadius: "50%", border: "1.5px solid #D6247A", background: "#FCE4EF", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#D6247A" }}
                        onClick={() => setSelected((prev) => ({ ...prev, [item.id]: (Number(prev[item.id]) || 0) + 1 }))}>+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 20px 32px", borderTop: "1px solid #F1F5F9" }}>
          <button
            style={{ ...s.doneLarge, background: usedCount > 0 ? "#D6247A" : "#fff", color: usedCount > 0 ? "#fff" : "#475569", borderColor: usedCount > 0 ? "#D6247A" : "#E2E8F0", fontWeight: 700 }}
            onClick={save} disabled={saving}>
            {saving ? "Gemmer…" : usedCount > 0 ? `${lang === "da" ? "Gem" : "Save"} ${usedCount} ${lang === "da" ? "produkter" : "products"}` : lang === "da" ? "Ingen produkter valgt — luk" : "No products — close"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Completion confirmation ───────────────────────────────────────────────────
function CompletionConfirm({ task, employee, usedProducts, minutes, lang, onConfirm, onCancel }) {
  const myLogged = (task.timeLog || []).filter((l) => l.empId === employee.id).reduce((s, l) => s + (l.minutes || 0), 0);
  const totalMin = myLogged + (Number(minutes) || 0);
  return (
    <div style={s.overlay} onClick={onCancel}>
      <div style={{ ...s.sheet, maxHeight: "80svh" }} onClick={(e) => e.stopPropagation()}>
        <div style={s.dragHandle} />
        <div style={{ padding: "16px 20px 0", fontWeight: 800, fontSize: 18, color: "#111111" }}>
          ✓ {lang === "da" ? "Bekræft afslutning" : "Confirm completion"}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px 20px" }}>
          <div style={{ background: "#F8FAFC", borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#111111", marginBottom: 8 }}>{task.title}</div>
            <div style={{ fontSize: 13, color: "#64748B" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #F1F5F9" }}>
                <span>⏱ {lang === "da" ? "Registreret tid" : "Logged time"}</span>
                <strong>{fmtMin(totalMin)}</strong>
              </div>
              {(task.checklist || []).length > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #F1F5F9" }}>
                  <span>✓ Tasks</span>
                  <strong>{(task.checklist || []).filter((i) => i.done).length}/{(task.checklist || []).length}</strong>
                </div>
              )}
              {usedProducts.length > 0 && (
                <div style={{ padding: "6px 0" }}>
                  <div style={{ marginBottom: 4 }}>📦 {lang === "da" ? "Produkter brugt" : "Products used"}</div>
                  {usedProducts.map((p) => (
                    <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#111111", padding: "2px 0" }}>
                      <span>{p.name}</span><strong>{p.qty} stk</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ padding: "12px 20px 32px", display: "flex", gap: 10 }}>
          <button style={{ ...s.doneLarge, flex: 1, fontSize: 14 }} onClick={onCancel}>
            {lang === "da" ? "Tilbage" : "Back"}
          </button>
          <button style={{ ...s.doneActiveLarge, flex: 1, fontSize: 14 }} onClick={onConfirm}>
            {lang === "da" ? "Bekræft & afslut" : "Confirm & complete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Task detail modal ─────────────────────────────────────────────────────────
function TaskModal({ task, employee, lang, onClose, onLogMinutes, onSetStatus, onToggleChecklist, supabaseClient }) {
  const tr = T[lang];
  const [hours, setHours] = useState("0");
  const [mins, setMins] = useState("00");
  const [saving, setSaving] = useState(false);
  const [translatedTask, setTranslatedTask] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [usedProducts, setUsedProducts] = useState([]);
  // Begrundelse ved overskridelse af planlagt tid
  const [overrunNote, setOverrunNote] = useState("");
  const [overrunError, setOverrunError] = useState(false);

  useEffect(() => {
    if (!task) return;
    if (lang === "da") { setTranslatedTask(null); return; }
    setTranslating(true);
    translateTask(task, lang).then((tt) => {
      setTranslatedTask(tt);
      setTranslating(false);
    });
  }, [task?.id, lang]);

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

  // Overskrider den SAMLEDE registrerede tid (alle medarbejdere) det planlagte,
  // naar denne registrering laegges til? Summen bruges bevidst, fordi opgavens
  // varighed er planlagt for hele opgaven - ikke pr. medarbejder.
  const pendingMinutes = Number(hours) * 60 + Number(mins) || 0;
  const projectedTotal = totalLogged + pendingMinutes;
  const willExceed = pendingMinutes > 0 && projectedTotal > t.duration;

  async function handleLog() {
    const m = pendingMinutes;
    if (!m || m <= 0) return;
    if (willExceed && !overrunNote.trim()) { setOverrunError(true); return; }
    if (!window.confirm(lang === "da" ? `Registrér ${fmtMin(m)}?` : `Log ${fmtMin(m)}?`)) return;
    setSaving(true);
    await onLogMinutes(t.id, m, willExceed ? overrunNote.trim() : null);
    setHours("0");
    setMins("00");
    setOverrunNote("");
    setOverrunError(false);
    setSaving(false);
  }

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

          {/* Access */}
          {t.accessInstructions && (
            <div style={s.sheetSection}>
              <div style={s.sheetSectionTitle}><Lock size={14} /> {tr.access}</div>
              <div style={s.sheetAccessText}>{t.accessInstructions}</div>
            </div>
          )}

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

          {/* Produkter brugt */}
          <div style={s.sheetSection}>
            <div style={s.sheetSectionTitle}>📦 {lang === "da" ? "Produkter" : "Products"}</div>
            {usedProducts.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {usedProducts.map((p) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0", color: "#111111" }}>
                    <span>{p.name}</span><strong>{p.qty} stk</strong>
                  </div>
                ))}
              </div>
            )}
            <button style={{ ...s.doneLarge, fontSize: 14 }} onClick={() => setShowProducts(true)}>
              📦 {usedProducts.length > 0 ? (lang === "da" ? "Ret produkter" : "Edit products") : (lang === "da" ? "Vælg produkter brugt" : "Select products used")}
            </button>
          </div>

          {/* Time tracking */}
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
            {willExceed && (
              <div style={s.overrunBox}>
                <div style={s.overrunTitle}>⚠️ {tr.overrunTitle}</div>
                <div style={s.overrunBody}>{tr.overrunBody(fmtMin(projectedTotal), fmtMin(t.duration))}</div>
                <textarea
                  style={{ ...s.overrunInput, borderColor: overrunError ? "#DC2626" : "#F59E0B" }}
                  placeholder={tr.overrunPlaceholder}
                  value={overrunNote}
                  onChange={(e) => { setOverrunNote(e.target.value); if (e.target.value.trim()) setOverrunError(false); }}
                  rows={2} />
                {overrunError && <div style={s.overrunError}>{tr.overrunRequired}</div>}
              </div>
            )}
            <div style={s.timeInputRow}>
              <select style={{ ...s.timeInput, flex: 0.3 }} value={hours} onChange={(e) => setHours(e.target.value)}>
                {Array.from({length: 13}, (_, i) => i).map(h => <option key={h} value={h}>{h}t</option>)}
              </select>
              <select style={{ ...s.timeInput, flex: 0.3 }} value={mins} onChange={(e) => setMins(e.target.value)}>
                {["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map(m => <option key={m} value={m}>{m}m</option>)}
              </select>
              <button style={{ ...s.timeLogBtn, opacity: (Number(hours) === 0 && mins === "00") || saving ? 0.4 : 1 }}
                onClick={handleLog} disabled={saving}>
                {saving ? tr.saving : tr.logTime}
              </button>
            </div>
          </div>

          {/* Done button → confirmation */}
          <div style={{ padding: "0 0 32px" }}>
            {done ? (
              <button style={s.doneActiveLarge} onClick={() => onSetStatus(task.id, false)}>
                <CheckCircle2 size={18} /> {tr.markNotDone}
              </button>
            ) : (
              <button style={s.doneLarge} onClick={() => setShowConfirm(true)}>
                <CheckCircle2 size={18} /> {tr.markDone}
              </button>
            )}
          </div>
        </div>
      </div>

      {showProducts && (
        <ProductPage
          task={task} employee={employee} lang={lang}
          supabaseClient={supabaseClient}
          onClose={() => setShowProducts(false)}
          onSave={(products) => { setUsedProducts(products); setShowProducts(false); }}
        />
      )}
      {showConfirm && (
        <CompletionConfirm
          task={task} employee={employee} lang={lang}
          usedProducts={usedProducts} minutes={mins}
          onCancel={() => setShowConfirm(false)}
          onConfirm={async () => {
            const totalMinutes = Number(hours) * 60 + Number(mins);
    if (totalMinutes > 0) await onLogMinutes(task.id, totalMinutes, willExceed ? overrunNote.trim() : null);
            await onSetStatus(task.id, true);
            setShowConfirm(false);
            onClose();
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
  const [lang, setLang] = useState(() => localStorage.getItem("wl_lang") || "en");
  const tr = T[lang];

  useEffect(() => { localStorage.setItem("wl_lang", lang); }, [lang]);

  // Persist lang change to employee row in DB
  async function changeLang(newLang) {
    setLang(newLang);
    if (employee) {
      await supabase.from("employees").update({ default_lang: newLang }).eq("id", employee.id);
    }
  }

  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [employee, setEmployee] = useState(null);
  const [instances, setInstances] = useState([]);
  const [travelSettings, setTravelSettings] = useState({ defaultMinutes: 20, dayStart: "07:00", overrides: {} });
  const [dataLoading, setDataLoading] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [day, setDay] = useState(todayWorkdayKey());
  const [openTask, setOpenTask] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showShop, setShowShop] = useState(false);
  const [showKm, setShowKm] = useState(false);
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
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => { setSession(session); setAuthLoading(false); });
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

  useEffect(() => {
    if (!session) return;
    async function load() {
      setDataLoading(true);
      const { data: empData } = await supabase.from("employees").select("*").eq("auth_user_id", session.user.id).single();
      if (!empData) { setDataLoading(false); return; }
      setEmployee(empData);

      // Apply saved language preference
      if (empData.default_lang && empData.default_lang !== lang) {
        setLang(empData.default_lang);
        localStorage.setItem("wl_lang", empData.default_lang);
      }

      const { week: targetWeek, year: targetYear } = weekInfoWithOffset(weekOffset);
      const { data: instData, error: instErr } = await supabase
        .from("instances").select("*").eq("week", targetWeek).eq("year", targetYear);
      if (instErr) console.error("load instances error:", instErr.message);
      const { data: customersData } = await supabase.from("customers").select("*");
      const custMap = Object.fromEntries((customersData || []).map((c) => [c.id, c]));

      const myInstances = (instData || [])
        .filter((i) => {
          const arr = typeof i.assignees === "string" ? JSON.parse(i.assignees) : (i.assignees || []);
          return arr.includes(empData.id);
        })
        .map((i) => {
          const cust = custMap[i.customer_id];
          return {
            ...i,
            timeLog: i.time_log ?? [],
            requiredSkills: i.required_skills ?? [],
            customerName: i.customer_name || cust?.name || "",
            address: i.address_text || cust?.address || "",
            accessInstructions: i.access_instructions || cust?.access_instructions || "",
            contractType: i.contract_type || i.contractType || "privat",
          };
        });

      setInstances(myInstances);

      const { data: travel } = await supabase.from("travel_settings").select("*").eq("id", "default").single();
      const { data: overrides } = await supabase.from("travel_overrides").select("*");
      if (travel) {
        setTravelSettings({
          defaultMinutes: travel.default_minutes,
          dayStart: travel.day_start,
          overrides: Object.fromEntries((overrides || []).map((o) => [travelKey(o.addr_a, o.addr_b), o.minutes])),
        });
      }
      setDataLoading(false);
    }
    load();
  }, [session, weekOffset]);

  useEffect(() => {
    if (openTask) {
      const updated = instances.find((t) => t.id === openTask.id);
      if (updated) setOpenTask(updated);
    }
  }, [instances]);

  async function logMinutes(taskId, minutes, note = null) {
    const m = Number(minutes);
    if (!employee || !m || m <= 0) return;
    const task = instances.find((t) => t.id === taskId);
    if (!task) return;
    // Atomar tilføjelse i databasen. Tidligere blev hele time_log-arrayet læst,
    // udvidet og skrevet tilbage — loggede to medarbejdere tid på samme opgave
    // samtidig, forsvandt den enes registrering sporløst.
    const { data: newLog, error } = await supabase.rpc("append_time_log", {
      p_instance_id: taskId, p_minutes: m, p_emp_id: employee.id, p_note: note,
    });
    if (error) {
      console.error("append_time_log:", error.message);
      alert("Kunne ikke gemme tiden — prøv igen.");
      return;
    }
    setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, timeLog: newLog, time_log: newLog } : t));
  }

  async function setStatus(taskId, done) {
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
      alert("Kunne ikke opdatere status — prøv igen.");
      return;
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
  }

  async function toggleChecklistItem(taskId, itemId) {
    const task = instances.find((t) => t.id === taskId);
    if (!task) return;
    const newChecklist = (task.checklist || []).map((i) => i.id === itemId ? { ...i, done: !i.done } : i);
    await supabase.from("instances").update({ checklist: newChecklist }).eq("id", taskId);
    setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, checklist: newChecklist } : t));
  }

  async function signOut() {
    await supabase.auth.signOut();
    setEmployee(null); setInstances([]);
  }

  if (authLoading) return <div style={s.loading}>{T[lang].loading}</div>;
if (recoveryToken) return React.createElement("div", { style: { display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"#FFF0F5",fontFamily:"system-ui" } }, React.createElement("div", { style: { background:"#fff",borderRadius:16,padding:28,width:320,textAlign:"center",boxShadow:"0 4px 24px rgba(0,0,0,0.08)" } }, React.createElement("div", { style: { fontWeight:700,fontSize:16,marginBottom:8 } }, "Nulstil adgangskode"), React.createElement("div", { style: { fontSize:13,color:"#666",marginBottom:16 } }, "Klik for at fortsætte."), React.createElement("button", { onClick: confirmRecovery, disabled: recoveryLoading, style: { width:"100%",padding:"12px 0",borderRadius:10,border:"none",background:"#D6247A",color:"#fff",fontWeight:700 } }, recoveryLoading ? "Bekræfter…" : "Fortsæt")));
  if (passwordRecovery) return <SetNewPasswordScreen lang={lang} setLang={setLang} onDone={() => { setPasswordRecovery(false); window.history.replaceState(null, "", window.location.pathname); }} />;
        if (!session) return <LoginScreen lang={lang} setLang={setLang} initialError={recoveryError} />;
  if (dataLoading) return <div style={s.loading}>{T[lang].fetchingTasks}</div>;
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
  const schedule = computeDaySchedule(myTasks, travelSettings);

  return (
    <div style={s.app}>

      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <img src="/app-icon.png" alt="Worklist" style={s.headerIcon} />
          <div>
            <div style={s.headerTitle}>{tr.appName}</div>
            <div style={s.headerSub}>{tr.week} {currentWeek}</div>
          </div>
        </div>
        <div style={s.headerRight}>
          <LangToggle lang={lang} setLang={changeLang} />
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
          const isToday = d.key === todayKey();
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
                  <div style={s.transportTime}>{fmtClock(seg.start)} · {tr.travel} · {fmtMin(seg.minutes)}</div>
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

      {showKm && (
        <KmPage
          employee={employee}
          lang={lang}
          supabaseClient={supabase}
          onClose={() => setShowKm(false)}
        />
      )}

      {/* Task modal */}
      {openTask && (
        <TaskModal
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
  empName: { fontSize:13, fontWeight:600, color:"#E2E8F0" },
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
  dayTab: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:"10px 0", border:"none", background:"transparent", cursor:"pointer", fontSize:12.5, fontWeight:600, color:"#94A3B8", gap:3 },
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
  timeInputRow: { display:"flex", gap:8 },
  // Advarsel + begrundelsesfelt naar registreret tid overskrider planlagt tid
  overrunBox: { background:"#FFFBEB", border:"1px solid #FDE68A", borderRadius:10, padding:"12px 14px", marginBottom:10 },
  overrunTitle: { fontSize:14, fontWeight:700, color:"#92400E", marginBottom:4 },
  overrunBody: { fontSize:13, color:"#92400E", lineHeight:1.45, marginBottom:10 },
  overrunInput: { width:"100%", boxSizing:"border-box", padding:"10px 12px", borderRadius:8, border:"1px solid #F59E0B",
    fontSize:15, fontFamily:"inherit", resize:"vertical", outline:"none", background:"#fff", color:"#111111" },
  overrunError: { fontSize:13, fontWeight:600, color:"#DC2626", marginTop:6 },
  timeInput: { flex:1, padding:"13px 14px", borderRadius:10, border:"1.5px solid #E2E8F0", fontSize:15, color:"#111111", background:"#fff" },
  timeLogBtn: { padding:"13px 18px", borderRadius:10, border:"none", background:"#111111", color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer", whiteSpace:"nowrap" },
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
    for (const [itemId, qty] of entries) {
      const amount = Number(qty);
      const item = items.find((i) => i.id === itemId);
      if (!item) continue;
      await supabaseClient.from("inventory_transactions").insert({
        item_id: itemId, quantity: -amount, type: "out",
        reason: lang === "da" ? `Bestilt af ${employee.name}` : `Ordered by ${employee.name}`,
        employee_id: employee.id,
      });
      const { error: stockErr2 } = await supabaseClient.rpc("consume_stock", { p_item_id: itemId, p_amount: amount });
      if (stockErr2) { console.error("consume_stock:", stockErr2.message); alert(`Kunne ikke opdatere lageret for "${item.name}" — prøv igen.`); setSaving(false); return; }
    }
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
                    <div style={{ flex: 1, fontSize:14,color:"#111111" }}>{tx.inventory_items?.name}</div>
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

