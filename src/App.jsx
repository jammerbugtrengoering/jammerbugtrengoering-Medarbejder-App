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
    logTime: "Log time",
    saving: "Saving…",
    markDone: "Mark as completed",
    markNotDone: "Mark as not completed",
    status: { planlagt: "Planned", i_gang: "In progress", udført: "Completed" },
    taskVideo: "Watch video",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
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
function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function todayKey() {
  const keys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const k = keys[new Date().getDay()];
  return ["Mon","Tue","Wed","Thu","Fri"].includes(k) ? k : "Mon";
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
function LoginScreen({ lang, setLang }) {
  const t = T[lang];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      </div>
    </div>
  );
}

// ── Task detail modal ─────────────────────────────────────────────────────────
function TaskModal({ task, employee, lang, onClose, onLogMinutes, onSetStatus, onToggleChecklist }) {
  const tr = T[lang];
  const [minutes, setMinutes] = useState("");
  const [saving, setSaving] = useState(false);
  if (!task) return null;

  const t = task;
  const myLogged = (t.timeLog || []).filter((l) => l.empId === employee.id).reduce((s, l) => s + (l.minutes || 0), 0);
  const totalLogged = (t.timeLog || []).reduce((s, l) => s + (l.minutes || 0), 0);
  const done = t.status === "udført";
  const clProg = { done: (t.checklist || []).filter((i) => i.done).length, total: (t.checklist || []).length };
  const mapsUrl = t.address
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.address)}`
    : null;

  async function handleLog() {
    const m = Number(minutes);
    if (!m || m <= 0) return;
    setSaving(true);
    await onLogMinutes(t.id, m);
    setMinutes("");
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
              {done ? "✓ " + tr.status["udført"] : t.status === "i_gang" ? "⚡ " + tr.status["i_gang"] : "⏳ " + tr.status["planlagt"]}
            </span>
            {t.contractType === "nexus" && (
              <span style={{ ...s.statusBadge, background: "#EEF2FF", color: "#4F46E5" }}>🏢 Nexus</span>
            )}
            {t.contractType === "privat" && (
              <span style={{ ...s.statusBadge, background: "#FFF6FA", color: "#9C1B5D" }}>🏠 Privat</span>
            )}
          </div>
          <div style={s.sheetTitle}>{t.title}</div>
          <div style={s.sheetMeta}>{fmtMin(t.duration)}{clProg.total > 0 ? ` · ${clProg.done}/${clProg.total} ${tr.tasks.toLowerCase()}` : ""}</div>

          {/* Customer + address + navigation + Nexus link */}
          {(t.customerName || t.address) && (
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
                <a
                  href="kmd-nexus://"
                  style={{ ...s.navBtnLarge, background: "#4F46E5", marginTop: 8 }}
                  onClick={(e) => {
                    // Fallback: hvis app ikke er installeret, åbn App Store / Google Play
                    setTimeout(() => {
                      const ua = navigator.userAgent;
                      if (/android/i.test(ua)) {
                        window.location.href = "https://play.google.com/store/apps/details?id=dk.kmd.nexusmobile2";
                      } else if (/iphone|ipad|ipod/i.test(ua)) {
                        window.location.href = "https://apps.apple.com/dk/app/kmd-nexus-mobile-2/id1234567890";
                      }
                    }, 1500);
                  }}>
                  🏢 Åbn KMD Nexus Mobile 2
                </a>
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
            <div style={s.timeInputRow}>
              <input type="number" min={1} step={5} placeholder={tr.minutesPlaceholder}
                style={s.timeInput} value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleLog(); }} />
              <button style={{ ...s.timeLogBtn, opacity: (!minutes || Number(minutes) <= 0 || saving) ? 0.4 : 1 }}
                onClick={handleLog} disabled={saving}>
                {saving ? tr.saving : tr.logTime}
              </button>
            </div>
          </div>

          {/* Done button */}
          <div style={{ padding: "0 0 32px" }}>
            <button style={done ? s.doneActiveLarge : s.doneLarge}
              onClick={() => onSetStatus(t.id, done ? "planlagt" : "udført")}>
              <CheckCircle2 size={18} />
              {done ? tr.markNotDone : tr.markDone}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────
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
  const [day, setDay] = useState(todayKey());
  const [openTask, setOpenTask] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  async function sendPasswordReset() {
    if (!session?.user?.email) return;
    setResetLoading(true);
    await supabase.auth.resetPasswordForEmail(session.user.email, {
      redirectTo: window.location.origin,
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

      const currentWeek = isoWeekNumber(new Date());
      const targetWeek = currentWeek + weekOffset;
      const { data: instData } = await supabase.from("instances").select("*").eq("week", targetWeek);
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

  async function logMinutes(taskId, minutes) {
    const m = Number(minutes);
    if (!employee || !m || m <= 0) return;
    const task = instances.find((t) => t.id === taskId);
    if (!task) return;
    const existing = task.time_log ?? task.timeLog ?? [];
    const newLog = [...existing, { minutes: m, empId: employee.id, ts: Date.now() }];
    const { error } = await supabase.from("instances").update({ time_log: newLog }).eq("id", taskId);
    if (!error) setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, timeLog: newLog, time_log: newLog } : t));
  }

  async function setStatus(taskId, status) {
    await supabase.from("instances").update({ status }).eq("id", taskId);
    setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, status } : t));
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
  if (!session) return <LoginScreen lang={lang} setLang={setLang} />;
  if (dataLoading) return <div style={s.loading}>{T[lang].fetchingTasks}</div>;
  if (!employee) return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={s.errorBox}>{tr.noProfileError}</div>
        <button style={s.loginBtn} onClick={signOut}>{tr.signOut}</button>
      </div>
    </div>
  );

  const currentWeek = isoWeekNumber(new Date()) + weekOffset;
  const DAYS = tr.days;
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
        <div style={s.weekLabel}>
          {tr.week} {currentWeek}
          {weekOffset === 0 && <span style={s.thisWeekTag}>{tr.thisWeek}</span>}
        </div>
        <button style={s.weekBtn} onClick={() => setWeekOffset((w) => w + 1)}><ChevronRight size={20} /></button>
        {weekOffset !== 0 && (
          <button style={s.todayBtn} onClick={() => setWeekOffset(0)}>{tr.today}</button>
        )}
      </div>

      {/* Day tabs */}
      <div style={s.dayBar}>
        {DAYS.map((d) => {
          const count = instances.filter((t) => t.day === d.key).length;
          return (
            <button key={d.key} style={d.key === day ? s.dayTabActive : s.dayTab} onClick={() => setDay(d.key)}>
              <span>{d.short}</span>
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
          const done = t.status === "udført";
          const inProgress = t.status === "i_gang";
          const myLogged = (t.timeLog || []).filter((l) => l.empId === employee.id).reduce((s, l) => s + (l.minutes || 0), 0);
          const clProg = { done: (t.checklist || []).filter((i) => i.done).length, total: (t.checklist || []).length };

          return (
            <div key={t.id} style={{ ...s.taskCard, opacity: done ? 0.7 : 1 }} onClick={() => setOpenTask(t)}>
              <div style={{ ...s.taskAccent, background: done ? "#22C55E" : inProgress ? "#F59E0B" : "#D6247A" }} />
              <div style={s.taskBody}>
                <div style={s.taskTime}>{fmtClock(seg.start)}</div>
                <div style={s.taskTitle}>{t.title}</div>
                {t.customerName && (
                  <div style={s.taskCustomer}>
                    <Building2 size={12} color="#9C1B5D" />
                    <span>{t.customerName}</span>
                    {t.contractType === "nexus" && <span style={{ fontSize: 10, fontWeight: 700, color: "#4F46E5", background: "#EEF2FF", borderRadius: 6, padding: "1px 6px", marginLeft: 4 }}>Nexus</span>}
                    {t.contractType === "privat" && <span style={{ fontSize: 10, fontWeight: 700, color: "#9C1B5D", background: "#FFF6FA", borderRadius: 6, padding: "1px 6px", marginLeft: 4 }}>Privat</span>}
                  </div>
                )}
                <div style={s.taskMeta}>
                  <span style={s.taskDuration}>{fmtMin(t.duration)}</span>
                  {clProg.total > 0 && (
                    <span style={s.taskChecklist}><ListChecks size={11} /> {clProg.done}/{clProg.total}</span>
                  )}
                  {myLogged > 0 && (
                    <span style={s.taskLogged}><Clock size={11} /> {fmtMin(myLogged)}</span>
                  )}
                </div>
              </div>
              <div style={s.taskRight}>
                {done ? <CheckCircle2 size={24} color="#22C55E" /> : <ChevronRight size={20} color="#CBD5E1" />}
              </div>
            </div>
          );
        })}
      </div>

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
  taskMeta: { display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" },
  taskDuration: { fontSize:12, color:"#64748B", fontWeight:500 },
  taskChecklist: { display:"flex", alignItems:"center", gap:3, fontSize:12, color:"#64748B" },
  taskLogged: { display:"flex", alignItems:"center", gap:3, fontSize:12, color:"#9C1B5D", fontWeight:600 },

  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:1000, display:"flex", alignItems:"flex-end" },
  sheet: { width:"100%", maxHeight:"92svh", background:"#fff", borderRadius:"20px 20px 0 0", display:"flex", flexDirection:"column", position:"relative" },
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
  timeInput: { flex:1, padding:"13px 14px", borderRadius:10, border:"1.5px solid #E2E8F0", fontSize:15, color:"#111111", background:"#fff" },
  timeLogBtn: { padding:"13px 18px", borderRadius:10, border:"none", background:"#111111", color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer", whiteSpace:"nowrap" },
  doneLarge: { width:"100%", padding:"16px 0", borderRadius:14, border:"2px solid #E2E8F0", background:"#fff", color:"#475569", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 },
  doneActiveLarge: { width:"100%", padding:"16px 0", borderRadius:14, border:"2px solid #22C55E", background:"#ECFDF5", color:"#16A34A", fontWeight:700, fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 },
};
