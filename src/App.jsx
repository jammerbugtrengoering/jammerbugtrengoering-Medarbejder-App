import React, { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import {
  Clock, CheckCircle2, Video, Lock, ListChecks, Check,
  Navigation, Building2, Car, LogOut, ChevronLeft, ChevronRight,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtMin(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}t${m > 0 ? " " + m + "m" : ""}` : `${m}m`;
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
  return keys[new Date().getDay()] || "Mon";
}
function travelKey(a, b) { return [a, b].sort().join(" || "); }
function getTravelMinutes(addrA, addrB, settings) {
  if (!addrA || !addrB || addrA === addrB) return 0;
  return settings.overrides?.[travelKey(addrA, addrB)] ?? settings.defaultMinutes;
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
        segments.push({ type: "transport", minutes: travel, start: cursor, end: cursor + travel, key: `${dayTasks[idx-1].id}->${t.id}` });
        cursor += travel;
      }
    }
    segments.push({ type: "task", task: t, start: cursor, end: cursor + t.duration });
    cursor += t.duration;
  });
  return segments;
}

const DAYS = [
  { key: "Mon", label: "Mandag" },
  { key: "Tue", label: "Tirsdag" },
  { key: "Wed", label: "Onsdag" },
  { key: "Thu", label: "Torsdag" },
  { key: "Fri", label: "Fredag" },
];

// ── Login screen ──────────────────────────────────────────────────────────────

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function login() {
    if (!email || !password) return;

    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
    }
  }

  return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={s.brand}>
          <div style={s.brandMark}>RP</div>
          <div>
            <div style={s.brandTitle}>Rengøringsplan</div>
            <div style={s.brandSub}>Medarbejder-app</div>
          </div>
        </div>

        <div style={s.loginLabel}>E-mail</div>
        <input
          type="email"
          style={s.loginInput}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="din@mail.dk"
        />

        <div style={s.loginLabel}>Password</div>
        <input
          type="password"
          style={s.loginInput}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          onKeyDown={(e) => {
            if (e.key === "Enter") login();
          }}
        />

        {error && <div style={s.errorMsg}>{error}</div>}

        <button
          style={s.loginBtn}
          onClick={login}
          disabled={loading}
        >
          {loading ? "Logger ind..." : "Log ind"}
        </button>
      </div>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────
export default function MedarbejderApp() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [employee, setEmployee] = useState(null);
  const [instances, setInstances] = useState([]);
  const [travelSettings, setTravelSettings] = useState({ defaultMinutes: 20, dayStart: "07:00", overrides: {} });
  const [dataLoading, setDataLoading] = useState(false);

  const [weekOffset, setWeekOffset] = useState(0); // relative to current week
  const [day, setDay] = useState(todayKey());
  const [openTaskId, setOpenTaskId] = useState(null);
  const [minuteInputs, setMinuteInputs] = useState({});

  // Auth listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setAuthLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Load data when logged in
  useEffect(() => {
    if (!session) return;
    async function load() {
      setDataLoading(true);
      // Find employee row
      const { data: empData } = await supabase
        .from("employees")
        .select("*")
        .eq("auth_user_id", session.user.id)
        .single();

      if (!empData) { setDataLoading(false); return; }
      setEmployee(empData);

      // Load instances assigned to this employee
      const currentWeek = isoWeekNumber(new Date());
      const targetWeek = currentWeek + weekOffset;
      const { data: instData } = await supabase
        .from("instances")
        .select("*")
        .contains("assignees", JSON.stringify([empData.id]))
        .eq("week", targetWeek);

      setInstances((instData || []).map((i) => ({
        ...i, timeLog: i.time_log ?? [], requiredSkills: i.required_skills ?? [],
      })));

      // Travel settings
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

  async function logMinutes(taskId, minutes) {
    if (!employee || minutes <= 0) return;
    const task = instances.find((t) => t.id === taskId);
    if (!task) return;
    const newLog = [...(task.time_log ?? task.timeLog ?? []), { minutes, empId: employee.id }];
    await supabase.from("instances").update({ time_log: newLog }).eq("id", taskId);
    setInstances((prev) => prev.map((t) => t.id === taskId ? { ...t, timeLog: newLog, time_log: newLog } : t));
    setMinuteInputs((prev) => ({ ...prev, [taskId]: "" }));
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
    setEmployee(null);
    setInstances([]);
  }

  if (authLoading) return <div style={s.loading}>Indlæser…</div>;
  if (!session) return <LoginScreen />;

  if (dataLoading) return <div style={s.loading}>Henter opgaver…</div>;

  if (!employee) return (
    <div style={s.loginWrap}>
      <div style={s.loginCard}>
        <div style={s.errorMsg}>Din bruger er ikke koblet til en medarbejder-profil. Kontakt din planlægger.</div>
        <button style={s.loginBtn} onClick={signOut}>Log ud</button>
      </div>
    </div>
  );

  const currentWeek = isoWeekNumber(new Date()) + weekOffset;
  const myTasks = instances.filter((t) => t.day === day);
  const schedule = computeDaySchedule(myTasks, travelSettings);

  return (
    <div style={s.app}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.brandMark}>RP</div>
          <div>
            <div style={s.brandTitle}>Rengøringsplan</div>
            <div style={s.brandSub}>Uge {currentWeek}</div>
          </div>
        </div>
        <div style={s.headerRight}>
          <div style={s.empName}>{employee.name}</div>
          <button style={s.signOutBtn} onClick={signOut}><LogOut size={14} /></button>
        </div>
      </div>

      {/* Week nav */}
      <div style={s.weekNav}>
        <button style={s.weekNavBtn} onClick={() => setWeekOffset((w) => w - 1)}><ChevronLeft size={18} /></button>
        <div style={s.weekNavLabel}>
          Uge {currentWeek}
          {weekOffset === 0 && <span style={s.nowTag}> · Denne uge</span>}
        </div>
        {weekOffset !== 0 && <button style={s.todayBtn} onClick={() => setWeekOffset(0)}>I dag</button>}
        <button style={s.weekNavBtn} onClick={() => setWeekOffset((w) => w + 1)}><ChevronRight size={18} /></button>
      </div>

      {/* Day tabs */}
      <div style={s.dayRow}>
        {DAYS.map((d) => (
          <button key={d.key} style={d.key === day ? s.dayBtnActive : s.dayBtn} onClick={() => setDay(d.key)}>
            {d.label.slice(0, 3)}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div style={s.list}>
        {myTasks.length === 0 && (
          <div style={s.empty}>Ingen opgaver {DAYS.find((d) => d.key === day)?.label.toLowerCase()}</div>
        )}
        {schedule.map((seg) => {
          if (seg.type === "transport") {
            return (
              <div key={seg.key} style={s.transportCard}>
                <Car size={13} /> {fmtClock(seg.start)} · Transport · {fmtMin(seg.minutes)}
              </div>
            );
          }
          const t = seg.task;
          const myLogged = (t.timeLog || []).filter((l) => l.empId === employee.id).reduce((sum, l) => sum + l.minutes, 0);
          const done = t.status === "udført";
          const open = openTaskId === t.id;
          const clProg = { done: (t.checklist || []).filter((i) => i.done).length, total: (t.checklist || []).length };
          const inputVal = minuteInputs[t.id] ?? "";

          return (
            <div key={t.id} style={{ ...s.card, opacity: done ? 0.65 : 1 }}>
              {/* Card header */}
              <div style={s.cardTop} onClick={() => setOpenTaskId(open ? null : t.id)}>
                <div style={s.cardTopLeft}>
                  <div style={s.cardTime}>{fmtClock(seg.start)}</div>
                  <div style={s.cardTitle}>{t.title}</div>
                  <div style={s.cardMeta}>{fmtMin(t.duration)}{clProg.total > 0 ? ` · ${clProg.done}/${clProg.total} tasks` : ""}</div>
                </div>
                {done && <CheckCircle2 size={22} color="#111111" />}
              </div>

              {/* Address */}
              {(t.customerName || t.address) && (
                <div style={s.addressRow}>
                  <Building2 size={13} color="#9C1B5D" style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {t.customerName && <div style={s.customerName}>{t.customerName}</div>}
                    {t.address && <div style={s.cardMeta}>{t.address}</div>}
                  </div>
                  {t.address && (
                    <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.address)}`}
                      target="_blank" rel="noreferrer" style={s.navBtn}>
                      <Navigation size={12} /> Naviger
                    </a>
                  )}
                </div>
              )}

              {/* Expanded body */}
              {open && (
                <div style={s.cardBody}>
                  {t.accessInstructions && (
                    <div style={s.accessBox}>
                      <div style={s.accessTitle}><Lock size={13} /> Adgang</div>
                      <div style={s.accessText}>{t.accessInstructions}</div>
                    </div>
                  )}
                  {t.videoUrl && (
                    <a href={t.videoUrl} target="_blank" rel="noreferrer" style={s.videoBtn}>
                      <Video size={14} /> Se instruktionsvideo
                    </a>
                  )}
                  {t.checklist && t.checklist.length > 0 && (
                    <div style={s.checklistBox}>
                      <div style={s.checklistTitle}><ListChecks size={13} /> Tasks ({clProg.done}/{clProg.total})</div>
                      {t.checklist.map((item) => (
                        <div key={item.id} style={s.checklistBlock}>
                          <button type="button" style={s.checklistRow}
                            onClick={(e) => { e.stopPropagation(); toggleChecklistItem(t.id, item.id); }}>
                            <span style={item.done ? s.cbDone : s.cbEmpty}>
                              {item.done && <Check size={11} color="#fff" />}
                            </span>
                            <span style={{ ...s.checklistText, textDecoration: item.done ? "line-through" : "none", color: item.done ? "#94A3B8" : "#111111" }}>
                              {item.text}
                            </span>
                          </button>
                          {item.description && <div style={s.checklistDesc}>{item.description}</div>}
                          {item.videoUrl && (
                            <a href={item.videoUrl} target="_blank" rel="noreferrer" style={s.videoBtnSm}>
                              <Video size={11} /> Video
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Footer: time log + done */}
              <div style={s.cardFooter}>
                <div style={s.timeLogged}><Clock size={12} /> {fmtMin(myLogged)} / {fmtMin(t.duration)}</div>
                <div style={s.footerRight}>
                  <input
                    type="number" min={1} step={5} placeholder="min"
                    style={s.minInput}
                    value={inputVal}
                    onChange={(e) => setMinuteInputs((prev) => ({ ...prev, [t.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && Number(inputVal) > 0) logMinutes(t.id, Number(inputVal)); }}
                  />
                  <button style={s.logBtn} disabled={!inputVal || Number(inputVal) <= 0}
                    onClick={() => logMinutes(t.id, Number(inputVal))}>
                    <Clock size={12} /> Gem
                  </button>
                  <button style={done ? s.doneBtnActive : s.doneBtn}
                    onClick={() => setStatus(t.id, done ? "planlagt" : "udført")}>
                    <CheckCircle2 size={12} /> {done ? "Udført ✓" : "Marker udført"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  app: { fontFamily: "'Inter', -apple-system, system-ui, sans-serif", background: "#FFF6FA", minHeight: "100svh", color: "#111111", display: "flex", flexDirection: "column" },
  loading: { display: "flex", alignItems: "center", justifyContent: "center", height: "100svh", fontSize: 15, color: "#9C1B5D" },

  // Auth
  loginWrap: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100svh", padding: 20, background: "#FFF6FA" },
  loginCard: { background: "#fff", borderRadius: 18, padding: 28, width: "100%", maxWidth: 360, boxShadow: "0 8px 32px rgba(0,0,0,0.10)" },
  brand: { display: "flex", alignItems: "center", gap: 12, marginBottom: 24 },
  brandMark: { width: 40, height: 40, borderRadius: 12, background: "#D6247A", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 15, color: "#fff" },
  brandTitle: { fontWeight: 700, fontSize: 16, color: "#111111" },
  brandSub: { fontSize: 12, color: "#94A3B8" },
  loginLabel: { fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 6 },
  loginInput: { width: "100%", padding: "11px 12px", borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 15, color: "#111111", background: "#fff", boxSizing: "border-box", marginBottom: 8 },
  loginBtn: { width: "100%", padding: "13px 0", borderRadius: 10, border: "none", background: "#D6247A", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer", marginTop: 6 },
  errorMsg: { color: "#B91C1C", fontSize: 13, marginBottom: 8 },
  sentBox: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "20px 0" },
  sentTitle: { fontWeight: 700, fontSize: 17, color: "#111111" },
  sentText: { fontSize: 13.5, color: "#475569", textAlign: "center", lineHeight: 1.5 },

  // Header
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", background: "#111111", color: "#fff" },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  empName: { fontWeight: 600, fontSize: 14, color: "#fff" },
  signOutBtn: { border: "none", background: "transparent", color: "#94A3B8", cursor: "pointer", padding: 4, display: "flex" },

  // Week nav
  weekNav: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px", background: "#fff", borderBottom: "1px solid #F0E4EA" },
  weekNavBtn: { border: "none", background: "#FFF6FA", borderRadius: 8, padding: 6, cursor: "pointer", display: "flex", color: "#111111" },
  weekNavLabel: { fontSize: 14, fontWeight: 600, color: "#111111", minWidth: 90, textAlign: "center" },
  nowTag: { color: "#D6247A", fontWeight: 700 },
  todayBtn: { border: "none", background: "#FCE4EF", color: "#D6247A", borderRadius: 8, padding: "5px 10px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },

  // Day row
  dayRow: { display: "flex", padding: "10px 12px", gap: 6, background: "#fff", borderBottom: "1px solid #F0E4EA" },
  dayBtn: { flex: 1, padding: "9px 0", borderRadius: 8, border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#475569", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  dayBtnActive: { flex: 1, padding: "9px 0", borderRadius: 8, border: "none", background: "#D6247A", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },

  // List
  list: { flex: 1, display: "flex", flexDirection: "column", gap: 10, padding: "12px 12px 32px", overflowY: "auto" },
  empty: { textAlign: "center", color: "#94A3B8", fontSize: 14, padding: "40px 0" },

  // Transport
  transportCard: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#64748B", background: "#F1EFE7", border: "1px dashed #CBD5E1", borderRadius: 10, padding: "8px 12px" },

  // Task card
  card: { background: "#fff", borderRadius: 14, boxShadow: "0 1px 4px rgba(0,0,0,0.07)", overflow: "hidden" },
  cardTop: { padding: "12px 14px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", cursor: "pointer" },
  cardTopLeft: { flex: 1, minWidth: 0 },
  cardTime: { fontSize: 11.5, fontWeight: 700, color: "#D6247A", marginBottom: 2 },
  cardTitle: { fontWeight: 700, fontSize: 15, color: "#111111", lineHeight: 1.3, marginBottom: 2 },
  cardMeta: { fontSize: 12, color: "#64748B" },

  // Address
  addressRow: { display: "flex", alignItems: "flex-start", gap: 8, background: "#F8FAFC", padding: "8px 14px", borderTop: "1px solid #F0E4EA" },
  customerName: { fontSize: 13, fontWeight: 700, color: "#111111", marginBottom: 1 },
  navBtn: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700, color: "#fff", background: "#D6247A", borderRadius: 8, padding: "6px 10px", textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" },

  // Card body
  cardBody: { padding: "0 14px 10px", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid #F0E4EA" },
  accessBox: { background: "#FCE4EF", borderRadius: 10, padding: 10, marginTop: 8 },
  accessTitle: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#9C1B5D", marginBottom: 4 },
  accessText: { fontSize: 13, color: "#111111", lineHeight: 1.5 },
  videoBtn: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#111111", background: "#FCE4EF", borderRadius: 8, padding: "8px 10px", textDecoration: "none" },

  // Checklist
  checklistBox: { background: "#F8FAFC", borderRadius: 10, padding: 10 },
  checklistTitle: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 },
  checklistBlock: { paddingBottom: 4, marginBottom: 4, borderBottom: "1px solid #F0E4EA" },
  checklistRow: { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "transparent", padding: "4px 0", cursor: "pointer", textAlign: "left" },
  cbEmpty: { width: 18, height: 18, borderRadius: 5, border: "1.5px solid #CBD5E1", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  cbDone: { width: 18, height: 18, borderRadius: 5, border: "1.5px solid #111111", background: "#111111", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  checklistText: { fontSize: 13.5, lineHeight: 1.4 },
  checklistDesc: { fontSize: 12, color: "#64748B", fontStyle: "italic", padding: "2px 26px 4px", lineHeight: 1.4 },
  videoBtnSm: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "#9C1B5D", background: "#FCE4EF", borderRadius: 6, padding: "3px 8px", textDecoration: "none", marginLeft: 26 },

  // Footer
  cardFooter: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "10px 14px", borderTop: "1px solid #F0E4EA", flexWrap: "wrap" },
  timeLogged: { display: "flex", alignItems: "center", gap: 4, fontSize: 12.5, color: "#64748B", flexShrink: 0 },
  footerRight: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  minInput: { width: 60, padding: "7px 6px", borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 13, textAlign: "center", color: "#111111", background: "#fff" },
  logBtn: { display: "flex", alignItems: "center", gap: 4, padding: "7px 10px", borderRadius: 8, border: "1px solid #E2E8F0", background: "#fff", color: "#334155", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  doneBtn: { display: "flex", alignItems: "center", gap: 4, padding: "7px 10px", borderRadius: 8, border: "1px solid #CBD5E1", background: "#fff", color: "#334155", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  doneBtnActive: { display: "flex", alignItems: "center", gap: 4, padding: "7px 10px", borderRadius: 8, border: "1px solid #111111", background: "#EDEDED", color: "#111111", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
};
