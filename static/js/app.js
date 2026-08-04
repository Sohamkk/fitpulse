/* FitPulse frontend — screen router + feature logic. No frameworks, real fetch calls to the Flask API. */

const state = {
  identifier: null,
  user: null,
  categories: null,
  activeCategory: "cardio",
  workoutQueue: [],
  workoutIndex: 0,
  timerHandle: null,
  timerSeconds: 0,
  timerTotal: 0,
  isResting: false,
  timerRunning: false,
  timerPaused: false,
  country: "IN",
  editingProfile: false,
  foodCategories: null,
  activeFoodCategory: null,
  foodLogToday: [],
  caloriesBurnedToday: 0,
  dietLocked: false,
  stats: null,
  restAdjustSeconds: 0,
  weeklyPlan: {},
  weightLog: [],
  reminder: { enabled: false, hour: 19, minute: 0 },
};

// ---------------------------------------------------------------------------
// Splash → check REAL server session → login or app
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  const mePromise = api("/api/me");
  setTimeout(async () => {
    const { data } = await mePromise;
    if (data.ok) {
      state.user = data.user;
      state.identifier = data.user.identifier;
      await enterApp();
    } else {
      showScreen("screen-login");
    }
  }, 1400);
});

// ---------------------------------------------------------------------------
// Screen router
// ---------------------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("active");
  el.scrollTop = 0;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.nav === id));
}

document.querySelectorAll("[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.nav));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function flash(elId, message, type = "error") {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.className = `status-msg show ${type}`;
}

// ---------------------------------------------------------------------------
// Auth: request + verify OTP
// ---------------------------------------------------------------------------
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const loginEmailBtn = document.getElementById("login-email-btn");
const registerEmailBtn = document.getElementById("register-email-btn");

loginEmailBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  if (!email || !password) return flash("login-status", "Enter your email and password.");

  loginEmailBtn.disabled = true;
  loginEmailBtn.textContent = "Signing in…";
  const { data } = await api("/api/auth/login", { method: "POST", body: { email, password } });
  loginEmailBtn.disabled = false;
  loginEmailBtn.textContent = "Sign in";

  if (!data.ok) return flash("login-status", data.error || "Could not sign in.");

  state.identifier = email;
  state.user = data.user;
  if (data.is_new_user) {
    showScreen("screen-profile-setup");
  } else {
    await enterApp();
  }
});

registerEmailBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  if (!email || !password) return flash("login-status", "Enter your email and password.");

  registerEmailBtn.disabled = true;
  registerEmailBtn.textContent = "Creating…";
  const { data } = await api("/api/auth/register", { method: "POST", body: { email, password, name: email.split("@", 1)[0] } });
  registerEmailBtn.disabled = false;
  registerEmailBtn.textContent = "Create account";

  if (!data.ok) return flash("login-status", data.error || "Could not create account.");

  state.identifier = email;
  state.user = data.user;
  if (data.is_new_user) {
    showScreen("screen-profile-setup");
  } else {
    await enterApp();
  }
});

// ---------------------------------------------------------------------------
// Profile setup
// ---------------------------------------------------------------------------
let selectedGender = "male";
document.querySelectorAll(".gender-toggle button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".gender-toggle button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    selectedGender = b.dataset.gender;
  });
});

document.getElementById("profile-save-btn").addEventListener("click", async () => {
  const payload = {
    name: document.getElementById("pf-name").value.trim(),
    age: Number(document.getElementById("pf-age").value),
    weight_kg: Number(document.getElementById("pf-weight").value),
    height_cm: Number(document.getElementById("pf-height").value),
    gender: selectedGender,
    activity_level: document.getElementById("pf-activity").value,
    goal: document.getElementById("pf-goal").value,
    country: document.getElementById("pf-country").value,
  };
  if (!payload.age || !payload.weight_kg || !payload.height_cm) {
    return flash("profile-status", "Fill in age, weight, and height.");
  }
  const { data } = await api("/api/profile", { method: "POST", body: payload });
  if (!data.ok) return flash("profile-status", data.error || "Could not save profile.");
  state.user = data.user;
  state.country = payload.country;

  if (state.editingProfile) {
    state.editingProfile = false;
    document.getElementById("pf-back-btn").classList.add("hidden");
    document.getElementById("pf-eyebrow").textContent = "Step 2 of 2";
    document.getElementById("pf-heading").textContent = "Tell us about you";
    await Promise.all([loadCalculatorResult(), loadExercises()]);
    renderAccountScreen();
    showScreen("screen-account");
  } else {
    await enterApp();
  }
});

document.getElementById("pf-back-btn").addEventListener("click", () => {
  state.editingProfile = false;
  document.getElementById("pf-back-btn").classList.add("hidden");
  showScreen("screen-account");
});

document.getElementById("edit-profile-btn").addEventListener("click", () => {
  const u = state.user || {};
  state.editingProfile = true;
  document.getElementById("pf-back-btn").classList.remove("hidden");
  document.getElementById("pf-eyebrow").textContent = "Editing";
  document.getElementById("pf-heading").textContent = "Update your details";

  document.getElementById("pf-name").value = u.name || "";
  document.getElementById("pf-age").value = u.age || "";
  document.getElementById("pf-weight").value = u.weight_kg || "";
  document.getElementById("pf-height").value = u.height_cm || "";
  document.getElementById("pf-activity").value = u.activity_level || "moderate";
  document.getElementById("pf-goal").value = u.goal || "maintain";
  document.getElementById("pf-country").value = u.country || "IN";

  selectedGender = u.gender || "male";
  document.querySelectorAll(".gender-toggle button").forEach((b) => {
    b.classList.toggle("active", b.dataset.gender === selectedGender);
  });

  showScreen("screen-profile-setup");
});

// ---------------------------------------------------------------------------
// Enter main app
// ---------------------------------------------------------------------------
async function enterApp() {
  document.getElementById("nav-bottom").classList.remove("hidden");
  renderGreeting();
  await Promise.all([
    loadCalculatorResult(),
    loadExercises(),
    loadPlans(),
    updateWorkoutsToday(),
    loadFoodDatabase(),
    loadWeightLog(),
    loadWeeklyPlan(),
    loadReminderSettings(),
  ]);
  renderDietSummary();
  await dailyCheckin();
  await ensureNotificationPermission();
  renderAccountScreen();
  renderTodaysPlanCard();
  checkStreakReminder();
  showScreen("screen-dashboard");
}

function localDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function dailyCheckin() {
  const { data } = await api("/api/checkin", { method: "POST", body: { local_date: localDateString() } });
  if (!data.ok) return;
  state.stats = data;
  renderStreakWidget(data);
  if (!data.already_checked_in_today && data.xp_gained > 0) {
    showUnlockToast({ name: "Daily check-in", desc: `+${data.xp_gained} XP just for showing up` });
  }
  (data.newly_unlocked || []).forEach(showUnlockToast);
}

async function refreshStreakWidget() {
  const { data } = await api("/api/stats");
  if (!data.ok) return;
  state.stats = data;
  renderStreakWidget(data);
}

function renderStreakWidget(stats) {
  document.getElementById("dash-streak-count").textContent = stats.streak;
  document.getElementById("dash-freeze-note").textContent =
    `${stats.freeze_available} streak freeze${stats.freeze_available === 1 ? "" : "s"} left this month`;
  document.getElementById("dash-level-name").textContent = stats.level;
  document.getElementById("dash-xp-count").textContent = stats.xp;

  const tiers = { Bronze: [0, 100], Silver: [100, 300], Gold: [300, 700], Platinum: [700, 1400] };
  const [lo, hi] = tiers[stats.level] || [0, 100];
  const pct = Math.min(100, Math.round(((stats.xp - lo) / (hi - lo)) * 100));
  document.getElementById("dash-xp-fill").style.width = pct + "%";
}

function showUnlockToast(item) {
  const toast = document.createElement("div");
  toast.className = "unlock-toast";
  toast.innerHTML = `<span style="font-size:20px;">🏆</span><div><strong>${item.name}</strong><div style="font-size:11px;color:var(--text-dim);">${item.desc}</div></div>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function renderGreeting() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  document.getElementById("greet-time").textContent = greet;
  const name = state.user?.name || "there";
  document.getElementById("greet-name").textContent = name;
  document.getElementById("avatar-initial").textContent = name.charAt(0).toUpperCase();
  document.getElementById("account-identifier").textContent = state.user?.identifier || state.identifier || "";
}

const GOAL_LABELS = { lose: "Lose weight", maintain: "Maintain weight", gain: "Build muscle" };
const ACTIVITY_LABELS = {
  sedentary: "Sedentary", light: "Light (1-3 days/week)", moderate: "Moderate (3-5 days/week)",
  active: "Active (6-7 days/week)", athlete: "Athlete (2x/day)",
};

function renderAccountScreen() {
  const u = state.user;
  if (!u) return;
  document.getElementById("avatar-initial-account").textContent = (u.name || "F").charAt(0).toUpperCase();
  document.getElementById("acc-plan").textContent = (u.plan || "free").charAt(0).toUpperCase() + (u.plan || "free").slice(1);
  document.getElementById("acc-target-cal").textContent = state.lastCalcResult?.target_calories ?? "—";
  document.getElementById("acc-age").textContent = u.age ?? "—";
  document.getElementById("acc-weight").textContent = u.weight_kg ? `${u.weight_kg} kg` : "—";
  document.getElementById("acc-height").textContent = u.height_cm ? `${u.height_cm} cm` : "—";
  document.getElementById("acc-goal").textContent = GOAL_LABELS[u.goal] || "—";
  document.getElementById("acc-activity").textContent = ACTIVITY_LABELS[u.activity_level] || "—";
  renderAchievements();
}

const BADGE_ICONS = {
  first_workout: "🎯", streak_3: "🔥", streak_7: "⚡", streak_30: "🏔️",
  xp_100: "🥈", xp_300: "🥇", xp_700: "💎", workouts_20: "🏅",
};

async function renderAchievements() {
  const { data } = await api("/api/stats");
  if (!data.ok) return;
  state.stats = data;

  document.getElementById("acc-level").textContent = data.level;
  document.getElementById("acc-streak").textContent = data.longest_streak;

  const grid = document.getElementById("acc-badge-grid");
  grid.innerHTML = "";
  data.unlockables.forEach((item) => {
    const el = document.createElement("div");
    el.className = "badge-item" + (item.unlocked ? " unlocked" : "");
    el.title = item.desc;
    el.innerHTML = `<span class="badge-icon">${BADGE_ICONS[item.id] || "🏆"}</span><span class="badge-name">${item.name}</span>`;
    grid.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// Daily streak reminder — browser Notification API.
// Note: this fires while the tab is open (foreground or backgrounded). It
// won't pop up if the browser itself is fully closed — that needs a service
// worker + push subscription + a server-side scheduler, which is a bigger
// addition on top of this.
// ---------------------------------------------------------------------------
async function loadReminderSettings() {
  const { data } = await api("/api/reminder-settings");
  if (!data.ok) return;
  state.reminder = { enabled: data.enabled, hour: data.hour, minute: data.minute };
  renderReminderUI();
}

function renderReminderUI() {
  const toggle = document.getElementById("reminder-toggle");
  toggle.classList.toggle("on", state.reminder.enabled);
  toggle.setAttribute("aria-pressed", String(state.reminder.enabled));
  document.getElementById("reminder-time-input").value =
    `${String(state.reminder.hour).padStart(2, "0")}:${String(state.reminder.minute).padStart(2, "0")}`;

  if (state.reminder.enabled && "Notification" in window && Notification.permission === "denied") {
    flash("reminder-status", "Notifications are blocked for this site — enable them in your browser settings to get reminders.");
  }
}

// Ask for notification access as soon as the app opens (rather than only
// when the user flips the reminder toggle), since reminders default to on.
async function ensureNotificationPermission() {
  if (!state.reminder.enabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "default") {
    renderReminderUI();
    return;
  }
  try {
    await Notification.requestPermission();
  } catch (e) {
    // ignore — browser may block programmatic prompts outside a user gesture
  }
  renderReminderUI();
}

async function saveReminderSettings() {
  const { data } = await api("/api/reminder-settings", {
    method: "POST",
    body: { enabled: state.reminder.enabled, hour: state.reminder.hour, minute: state.reminder.minute },
  });
  if (!data.ok) return flash("reminder-status", data.error || "Could not save reminder settings.");
  const timeStr = document.getElementById("reminder-time-input").value;
  flash(
    "reminder-status",
    state.reminder.enabled ? `We'll nudge you around ${timeStr} if you haven't checked in yet.` : "Daily reminder turned off.",
    "success"
  );
}

document.getElementById("reminder-toggle").addEventListener("click", async () => {
  const turningOn = !state.reminder.enabled;

  if (turningOn) {
    if (!("Notification" in window)) {
      return flash("reminder-status", "This browser doesn't support notifications.");
    }
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        return flash("reminder-status", "Allow notifications in your browser to turn this on.");
      }
    } else if (Notification.permission === "denied") {
      return flash("reminder-status", "Notifications are blocked for this site — enable them in your browser settings.");
    }
  }

  state.reminder.enabled = turningOn;
  renderReminderUI();
  await saveReminderSettings();
});

document.getElementById("reminder-time-input").addEventListener("change", async (e) => {
  const [h, m] = e.target.value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return;
  state.reminder.hour = h;
  state.reminder.minute = m;
  await saveReminderSettings();
});

let lastReminderFiredDate = null;
function checkStreakReminder() {
  if (!state.reminder.enabled) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const today = localDateString();
  const checkedInToday = state.stats?.last_checkin_date === today;
  if (checkedInToday || lastReminderFiredDate === today) return;

  const now = new Date();
  const dueTime = new Date();
  dueTime.setHours(state.reminder.hour, state.reminder.minute, 0, 0);
  if (now < dueTime) return;

  const streak = state.stats?.streak || 0;
  const body = streak > 0
    ? `Don't lose your ${streak}-day streak 🔥 — check in before the day resets.`
    : "Open FitPulse and check in to start your streak 🔥";
  new Notification("FitPulse", { body });
  lastReminderFiredDate = today;
}
setInterval(checkStreakReminder, 60000);

// ---------------------------------------------------------------------------
// Calorie calculator
// ---------------------------------------------------------------------------
async function loadCalculatorResult() {
  const u = state.user;
  if (!u || !u.age || !u.weight_kg || !u.height_cm) return;
  const { data } = await api("/api/calculate", {
    method: "POST",
    body: {
      age: u.age, weight_kg: u.weight_kg, height_cm: u.height_cm,
      gender: u.gender, activity_level: u.activity_level, goal: u.goal,
    },
  });
  if (!data.ok) return;
  state.lastCalcResult = data;
  document.getElementById("calc-target").textContent = data.target_calories;
  document.getElementById("calc-bmr").textContent = data.bmr;
  document.getElementById("calc-tdee").textContent = data.tdee;
  document.getElementById("calc-bmi").textContent = `${data.bmi} · ${data.bmi_label}`;
  document.getElementById("macro-protein").textContent = `${data.macros.protein_g}g`;
  document.getElementById("macro-carbs").textContent = `${data.macros.carbs_g}g`;
  document.getElementById("macro-fat").textContent = `${data.macros.fat_g}g`;
  document.getElementById("dash-target-cal").textContent = data.target_calories;
}

// ---------------------------------------------------------------------------
// Weight tracker — weekly log + SVG line chart on the Account screen
// ---------------------------------------------------------------------------
async function loadWeightLog() {
  const { data } = await api("/api/weight-log");
  if (!data.ok) return;
  state.weightLog = data.log;
  renderWeightChart();
}

document.getElementById("weight-log-btn").addEventListener("click", async () => {
  const input = document.getElementById("weight-log-input");
  const val = Number(input.value);
  if (!val || val < 20 || val > 400) {
    return flash("weight-log-status", "Enter a weight between 20 and 400 kg.");
  }
  const btn = document.getElementById("weight-log-btn");
  btn.disabled = true;
  const { data } = await api("/api/weight-log", {
    method: "POST",
    body: { weight_kg: val, local_date: localDateString() },
  });
  btn.disabled = false;
  if (!data.ok) return flash("weight-log-status", data.error || "Could not log your weight.");

  input.value = "";
  flash("weight-log-status", "Weight logged.", "success");
  state.user = data.user;
  document.getElementById("acc-weight").textContent = `${data.weight_kg} kg`;
  await loadWeightLog();
  await loadCalculatorResult();
});

function renderWeightChart() {
  const svg = document.getElementById("weight-chart");
  const empty = document.getElementById("weight-chart-empty");
  const log = state.weightLog || [];

  if (log.length < 2) {
    svg.style.display = "none";
    empty.style.display = "block";
    svg.innerHTML = "";
    return;
  }
  svg.style.display = "block";
  empty.style.display = "none";

  const W = 320, H = 140, PAD = 16;
  const weights = log.map((r) => r.weight_kg);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const range = max - min || 1;
  const stepX = (W - PAD * 2) / (log.length - 1);

  const points = log.map((r, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((r.weight_kg - min) / range) * (H - PAD * 2);
    return [x, y];
  });

  const pathD = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const areaD = `${pathD} L${points[points.length - 1][0]},${H - PAD} L${points[0][0]},${H - PAD} Z`;

  const ns = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";

  const area = document.createElementNS(ns, "path");
  area.setAttribute("d", areaD);
  area.setAttribute("fill", "rgba(199,244,100,0.12)");
  area.setAttribute("stroke", "none");
  svg.appendChild(area);

  const line = document.createElementNS(ns, "path");
  line.setAttribute("d", pathD);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#C7F464");
  line.setAttribute("stroke-width", "2.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  points.forEach(([x, y], i) => {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", i === points.length - 1 ? 4 : 2.5);
    dot.setAttribute("fill", i === points.length - 1 ? "#C7F464" : "#9BA1A8");
    const title = document.createElementNS(ns, "title");
    title.textContent = `${log[i].logged_date}: ${log[i].weight_kg} kg`;
    dot.appendChild(title);
    svg.appendChild(dot);
  });
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------
async function loadExercises() {
  const { data } = await api("/api/exercises");
  if (!data.ok) return;
  state.categories = data.categories;
  renderCategoryChips();
  renderExerciseList(state.activeCategory);
  renderDashboardPreview();
}

// ---------------------------------------------------------------------------
// Diet tracker
// ---------------------------------------------------------------------------
async function loadFoodDatabase() {
  const { data } = await api("/api/foods");
  if (!data.ok) return;
  state.foodCategories = data.categories;
  state.dietLocked = !!data.locked;
  if (!state.activeFoodCategory) {
    state.activeFoodCategory = Object.keys(data.categories)[0];
  }
  renderFoodCategoryChips();
  await loadFoodLogToday();
  renderFoodList(state.activeFoodCategory);
}

async function loadFoodLogToday() {
  const { data } = await api("/api/food-log");
  if (!data.ok) return;
  state.foodLogToday = data.log.filter((f) => isLoggedToday(f.logged_at));
  renderDietSummary();
}

function renderFoodCategoryChips() {
  const wrap = document.getElementById("diet-category-chips");
  wrap.innerHTML = "";
  if (state.dietLocked) return;
  Object.entries(state.foodCategories).forEach(([key, cat]) => {
    const chip = document.createElement("button");
    chip.className = "category-chip" + (key === state.activeFoodCategory ? " active" : "");
    chip.textContent = cat.label;
    chip.addEventListener("click", () => {
      state.activeFoodCategory = key;
      renderFoodCategoryChips();
      renderFoodList(key, document.getElementById("diet-search-input").value);
    });
    wrap.appendChild(chip);
  });
}

function countLoggedToday(foodName) {
  return state.foodLogToday.filter((f) => f.food_name === foodName).length;
}

function renderFoodList(catKey, query) {
  const list = document.getElementById("diet-food-list");
  list.innerHTML = "";

  if (state.dietLocked) {
    list.innerHTML = `
      <div class="upgrade-prompt">
        <div class="upgrade-prompt-title">🔒 Diet tracker is a Premium feature</div>
        <p class="subtext">Upgrade to log food, track calories eaten vs. burned, and see your daily remaining budget update live.</p>
        <button class="btn btn-primary" id="upgrade-from-diet-btn">See plans</button>
      </div>`;
    document.getElementById("upgrade-from-diet-btn").addEventListener("click", () => showScreen("screen-plans"));
    return;
  }

  const q = (query || "").trim().toLowerCase();

  let items;
  if (q) {
    items = [];
    Object.values(state.foodCategories).forEach((cat) => {
      cat.items.forEach((it) => {
        if (it.name.toLowerCase().includes(q)) items.push(it);
      });
    });
  } else {
    items = state.foodCategories[catKey].items;
  }

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "food-card";
    const count = countLoggedToday(item.name);
    card.innerHTML = `
      <div>
        <div class="food-card-name">${item.name}</div>
        <div class="food-card-sub">${item.serving} · ${Math.round(item.calories)} kcal</div>
      </div>
      <div class="food-stepper">
        <button class="minus" ${count === 0 ? "disabled" : ""}>−</button>
        <span class="food-stepper-count">${count}</span>
        <button class="plus">+</button>
      </div>
    `;
    card.querySelector(".plus").addEventListener("click", () => logFoodItem(item));
    card.querySelector(".minus").addEventListener("click", () => removeLastFoodLog(item));
    list.appendChild(card);
  });

  if (!items.length) {
    list.innerHTML = `<p class="subtext">No foods found.</p>`;
  }
}

async function logFoodItem(item) {
  const { data } = await api("/api/log-food", {
    method: "POST",
    body: {
      food_name: item.name,
      calories: item.calories,
      protein_g: item.protein_g,
      carbs_g: item.carbs_g,
      fat_g: item.fat_g,
    },
  });
  if (!data.ok) return;
  await loadFoodLogToday();
  renderFoodList(state.activeFoodCategory, document.getElementById("diet-search-input").value);
}

async function removeLastFoodLog(item) {
  const matches = state.foodLogToday.filter((f) => f.food_name === item.name);
  if (!matches.length) return;
  const latest = matches.reduce((a, b) => (a.id > b.id ? a : b));
  const { data } = await api(`/api/food-log/${latest.id}`, { method: "DELETE" });
  if (!data.ok) return;
  await loadFoodLogToday();
  renderFoodList(state.activeFoodCategory, document.getElementById("diet-search-input").value);
}

function renderDietSummary() {
  const target = state.lastCalcResult ? state.lastCalcResult.target_calories : null;
  const eaten = state.foodLogToday.reduce((sum, f) => sum + (f.calories || 0), 0);
  const burned = state.caloriesBurnedToday || 0;

  document.getElementById("diet-eaten").textContent = Math.round(eaten);
  document.getElementById("diet-burned").textContent = Math.round(burned);

  if (target == null) {
    document.getElementById("diet-target").textContent = "—";
    document.getElementById("diet-remaining").textContent = "—";
    document.getElementById("dash-target-cal").textContent = "—";
    return;
  }

  const remaining = Math.round(target - eaten + burned);
  document.getElementById("diet-target").textContent = target;
  document.getElementById("diet-remaining").textContent = remaining;
  document.getElementById("dash-target-cal").textContent = remaining;
}

document.getElementById("diet-search-input").addEventListener("input", (e) => {
  renderFoodList(state.activeFoodCategory, e.target.value);
});

function isLoggedToday(timestampStr) {
  if (!timestampStr) return false;
  // Stored as a UTC timestamp string "YYYY-MM-DD HH:MM:SS" — convert to a
  // real Date so "today" is judged in the user's own timezone, not the server's.
  const d = new Date(timestampStr.replace(" ", "T") + "Z");
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

async function updateWorkoutsToday() {
  const { data } = await api("/api/history");
  if (!data.ok) return;
  const todays = data.history.filter((h) => isLoggedToday(h.logged_at));
  const el = document.getElementById("dash-workouts-today");
  if (el) el.textContent = todays.length;
  state.caloriesBurnedToday = todays.reduce((sum, h) => sum + (h.calories || 0), 0);
  renderDietSummary();
}

function renderCategoryChips() {
  const wrap = document.getElementById("category-chips");
  wrap.innerHTML = "";
  Object.entries(state.categories).forEach(([key, cat]) => {
    const chip = document.createElement("button");
    chip.className = "category-chip" + (key === state.activeCategory ? " active" : "");
    chip.textContent = cat.locked ? `🔒 ${cat.label}` : cat.label;
    chip.setAttribute("aria-pressed", String(key === state.activeCategory));
    chip.addEventListener("click", () => {
      state.activeCategory = key;
      renderCategoryChips();
      renderExerciseList(key);
    });
    wrap.appendChild(chip);
  });
}

function renderExerciseList(catKey) {
  const cat = state.categories[catKey];
  const list = document.getElementById("exercise-list");
  const startAllBtn = document.getElementById("start-category-btn");

  list.innerHTML = "";

  if (cat.locked) {
    const prompt = document.createElement("div");
    prompt.className = "upgrade-prompt";
    prompt.innerHTML = `
      <div class="upgrade-prompt-title">🔒 ${cat.label} is a Premium category</div>
      <p class="subtext">Upgrade to unlock all 13 workout categories, including ${cat.label}.</p>
      <button class="btn btn-primary" id="upgrade-from-exercises-btn">See plans</button>
    `;
    prompt.querySelector("#upgrade-from-exercises-btn").addEventListener("click", () => showScreen("screen-plans"));
    list.appendChild(prompt);
    startAllBtn.style.display = "none";
    return;
  }
  startAllBtn.style.display = "";

  cat.items.forEach((ex) => {
    const card = document.createElement("div");
    card.className = "exercise-card";
    card.innerHTML = `
      <div class="exercise-meta">
        <span class="exercise-dot" style="background:${cat.color}"></span>
        <div>
          <div class="exercise-name">${ex.name}</div>
          <div class="exercise-sub">${ex.duration}s work · ${ex.rest}s rest · ${ex.equipment || "Bodyweight"} · ~${estCalories(ex)} kcal</div>
        </div>
      </div>
      <div class="exercise-go">→</div>`;
    card.addEventListener("click", () => startWorkout(catKey, [ex]));
    list.appendChild(card);
  });

  startAllBtn.textContent = `Start full ${cat.label} circuit`;
  startAllBtn.onclick = () => startWorkout(catKey, cat.items);
}

function estCalories(ex) {
  const weight = state.user?.weight_kg || 70;
  return Math.round(ex.met * weight * (ex.duration / 3600));
}

// ---------------------------------------------------------------------------
// Weekly workout plan — Monday-Saturday, any number of categories (or rest) per day
// ---------------------------------------------------------------------------
const WEEKLY_PLAN_DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function loadWeeklyPlan() {
  const { data } = await api("/api/weekly-plan");
  if (!data.ok) return;
  state.weeklyPlan = data.plan;
}

function renderWeeklyPlanForm() {
  const wrap = document.getElementById("weekly-plan-list");
  wrap.innerHTML = "";
  if (!state.categories) return;

  WEEKLY_PLAN_DAY_LABELS.forEach((label, i) => {
    const selected = new Set(state.weeklyPlan[String(i)] || []);
    const chips = Object.entries(state.categories)
      .map(([key, cat]) => `
        <button type="button" class="category-chip weekly-plan-chip${selected.has(key) ? " active" : ""}" data-day="${i}" data-category="${key}">
          ${cat.locked ? "🔒 " : ""}${cat.label}
        </button>`)
      .join("");

    const row = document.createElement("div");
    row.className = "weekly-plan-day-row";
    row.innerHTML = `
      <div class="weekly-plan-day-label">${label}</div>
      <div class="weekly-plan-day-chips" data-day-chips="${i}">${chips}</div>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll(".weekly-plan-chip").forEach((chip) => {
    chip.addEventListener("click", () => chip.classList.toggle("active"));
  });
}

document.getElementById("open-weekly-plan-btn").addEventListener("click", () => {
  renderWeeklyPlanForm();
  showScreen("screen-weekly-plan");
});

document.getElementById("weekly-plan-back-btn").addEventListener("click", () => {
  showScreen("screen-exercises");
});

document.getElementById("weekly-plan-save-btn").addEventListener("click", async () => {
  const plan = {};
  WEEKLY_PLAN_DAY_LABELS.forEach((_, i) => {
    plan[i] = Array.from(document.querySelectorAll(`.weekly-plan-chip.active[data-day="${i}"]`))
      .map((chip) => chip.dataset.category);
  });

  const btn = document.getElementById("weekly-plan-save-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  const { data } = await api("/api/weekly-plan", { method: "POST", body: { plan } });
  btn.disabled = false;
  btn.textContent = "Save plan";

  if (!data.ok) return flash("weekly-plan-status", data.error || "Could not save your plan.");
  state.weeklyPlan = plan;
  flash("weekly-plan-status", "Weekly plan saved.", "success");
  renderTodaysPlanCard();
});

function renderTodaysPlanCard() {
  const wrap = document.getElementById("dash-today-plan");
  if (!wrap || !state.categories) return;

  const jsDay = new Date().getDay(); // 0 = Sunday .. 6 = Saturday
  const dayIndex = jsDay === 0 ? null : jsDay - 1; // null = Sunday = always rest
  const catKeys = dayIndex === null ? [] : (state.weeklyPlan[String(dayIndex)] || []);

  if (!catKeys.length) {
    wrap.innerHTML = `
      <div class="exercise-card" style="cursor:default;">
        <div class="exercise-meta">
          <span class="exercise-dot" style="background:var(--steel)"></span>
          <div>
            <div class="exercise-name">Rest day</div>
            <div class="exercise-sub">${dayIndex === null ? "Enjoy it — back tomorrow." : "Nothing planned — set one in your weekly plan."}</div>
          </div>
        </div>
      </div>`;
    return;
  }

  wrap.innerHTML = "";
  catKeys.forEach((catKey) => {
    const cat = state.categories[catKey];
    if (!cat) return;
    const card = document.createElement("div");
    card.className = "exercise-card";
    card.innerHTML = `
      <div class="exercise-meta">
        <span class="exercise-dot" style="background:${cat.color}"></span>
        <div>
          <div class="exercise-name">${cat.label}</div>
          <div class="exercise-sub">${cat.locked ? "Premium category — tap to unlock" : `${cat.items.length} exercises planned for today`}</div>
        </div>
      </div>
      <div class="exercise-go">→</div>`;
    card.addEventListener("click", () => {
      state.activeCategory = catKey;
      renderCategoryChips();
      renderExerciseList(catKey);
      showScreen("screen-exercises");
    });
    wrap.appendChild(card);
  });
}

function renderDashboardPreview() {
  const wrap = document.getElementById("dash-preview");
  wrap.innerHTML = "";
  const cat = state.categories["cardio"];
  cat.items.slice(0, 3).forEach((ex) => {
    const card = document.createElement("div");
    card.className = "exercise-card";
    card.innerHTML = `
      <div class="exercise-meta">
        <span class="exercise-dot" style="background:${cat.color}"></span>
        <div>
          <div class="exercise-name">${ex.name}</div>
          <div class="exercise-sub">${ex.duration}s work · ~${estCalories(ex)} kcal</div>
        </div>
      </div>
      <div class="exercise-go">→</div>`;
    card.addEventListener("click", () => startWorkout("cardio", [ex]));
    wrap.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Timer engine
// ---------------------------------------------------------------------------
const RING_RADIUS = 120;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

const MISSION_THEMES = {
  cardio: { title: "🚨 THE CHASE", verb: "outrun the alarm" },
  strength: { title: "🔐 THE VAULT", verb: "force the door" },
  hiit: { title: "💣 THE COUNTDOWN", verb: "defuse it in time" },
  yoga: { title: "🏛️ THE SANCTUARY", verb: "calm the guardian" },
  stretching: { title: "🧊 THE COOLDOWN CHAMBER", verb: "reset before the next heist" },
  chest: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  triceps: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  back: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  biceps: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  shoulders: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  traps: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  forearms: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  abs: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
  legs: { title: "⚒️ THE FORGE", verb: "power the mechanism" },
};

function renderMissionBanner(exercise, phase) {
  const theme = MISSION_THEMES[exercise.category] || { title: "🎯 THE MISSION", verb: "complete the objective" };
  document.getElementById("mission-title").textContent = theme.title;
  const doorNum = state.workoutIndex + 1;
  const doorTotal = state.workoutQueue.length;
  if (phase === "work") {
    document.getElementById("mission-line").textContent =
      `Door ${doorNum} of ${doorTotal} — ${exercise.duration}s of ${exercise.name} to ${theme.verb}.`;
  } else {
    document.getElementById("mission-line").textContent = `Door ${doorNum} unlocked. Catch your breath before the next one.`;
  }
  const pct = Math.round((state.workoutIndex / doorTotal) * 100);
  document.getElementById("mission-progress-fill").style.width = pct + "%";
}

function startWorkout(catKey, items) {
  state.workoutQueue = items.map((it) => ({ ...it, category: catKey }));
  state.workoutIndex = 0;
  state.timerRunning = false;
  state.timerPaused = false;
  showScreen("screen-timer");
  renderTimerDots();
  prepareStep(state.workoutQueue[0], "work");
  updateTimerControls();
}

function renderTimerDots() {
  const wrap = document.getElementById("timer-dots");
  wrap.innerHTML = "";
  state.workoutQueue.forEach((_, i) => {
    const dot = document.createElement("span");
    if (i < state.workoutIndex) dot.className = "done";
    if (i === state.workoutIndex) dot.className = "current";
    wrap.appendChild(dot);
  });
}

function prepareStep(exercise, phase) {
  clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.timerRunning = false;
  state.timerPaused = false;
  let duration = phase === "work" ? exercise.duration : exercise.rest;
  if (phase === "rest") {
    duration = Math.max(5, duration + (state.restAdjustSeconds || 0));
    state.restAdjustSeconds = 0;
  }
  state.timerTotal = duration;
  state.timerSeconds = duration;
  state.isResting = phase === "rest";

  const ring = document.getElementById("ring-progress");
  ring.style.strokeDasharray = RING_CIRC;
  ring.classList.toggle("resting", state.isResting);
  document.getElementById("timer-exercise-name").textContent = phase === "work" ? exercise.name : "Rest";
  document.getElementById("timer-label").textContent = phase === "work" ? "Work" : "Recover";
  document.getElementById("timer-ring-container").classList.toggle("breathing", state.isResting);
  renderMuscleDiagram(phase === "work" ? exercise.muscles : []);
  renderMissionBanner(exercise, phase);
  document.querySelectorAll("#muscle-diagram .body-svg").forEach((svg) => svg.classList.toggle("glowing", phase === "work"));

  updateRing();
}

function updateTimerControls() {
  const startBtn = document.getElementById("timer-start-btn");
  const pauseBtn = document.getElementById("timer-pause-btn");
  if (!startBtn || !pauseBtn) return;
  startBtn.disabled = state.timerRunning;
  startBtn.textContent = state.timerRunning ? "Running…" : state.timerPaused ? "Resume" : "Start";
  pauseBtn.textContent = state.timerPaused ? "▶" : "⏸";
}

function startCurrentTimer() {
  const ex = state.workoutQueue[state.workoutIndex];
  if (!ex || state.timerRunning) return;
  state.timerRunning = true;
  state.timerPaused = false;
  updateTimerControls();
  state.timerHandle = setInterval(() => {
    state.timerSeconds -= 1;
    updateRing();
    if (state.timerSeconds <= 0) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
      state.timerRunning = false;
      state.timerPaused = false;
      advanceWorkout(ex, state.isResting ? "rest" : "work");
    }
  }, 1000);
}

function runStep(exercise, phase) {
  prepareStep(exercise, phase);
  updateTimerControls();
}

function updateRing() {
  const ring = document.getElementById("ring-progress");
  const pct = state.timerSeconds / state.timerTotal;
  ring.style.strokeDashoffset = RING_CIRC * (1 - pct);
  document.getElementById("timer-value").textContent = state.timerSeconds;
}

const MUSCLE_LABELS = {
  shoulders: "Shoulders", chest: "Chest", biceps: "Biceps", triceps: "Triceps",
  forearms: "Forearms", abs: "Abs", obliques: "Obliques", quads: "Quads",
  hamstrings: "Hamstrings", calves: "Calves", glutes: "Glutes", lats: "Lats",
  upper_back: "Upper back", lower_back: "Lower back",
};

function renderMuscleDiagram(muscles = []) {
  document.querySelectorAll("#muscle-diagram [data-muscle]").forEach((el) => {
    el.classList.toggle("active", muscles.includes(el.dataset.muscle));
  });
  const legend = document.getElementById("muscle-diagram-legend");
  if (!muscles.length) {
    legend.innerHTML = "";
    return;
  }
  legend.innerHTML =
    "Targets: " +
    muscles.map((m) => `<span class="active-label">${MUSCLE_LABELS[m] || m}</span>`).join(", ");
}

async function advanceWorkout(exercise, phase) {
  if (phase === "work") {
    // log calories burned (and XP/unlocks) for this segment
    api("/api/log-workout", {
      method: "POST",
      body: { exercise_name: exercise.name, category: exercise.category, duration_sec: exercise.duration, met: exercise.met },
    }).then(({ data }) => {
      if (data.ok) {
        (data.newly_unlocked || []).forEach(showUnlockToast);
        refreshStreakWidget();
      }
    });
    runStep(exercise, "rest");
    return;
  }
  // rest finished → next exercise or done
  state.workoutIndex += 1;
  renderTimerDots();
  if (state.workoutIndex >= state.workoutQueue.length) {
    finishWorkout();
    return;
  }
  runStep(state.workoutQueue[state.workoutIndex], "work");
}

function finishWorkout() {
  clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.timerRunning = false;
  state.timerPaused = false;
  document.getElementById("timer-exercise-name").textContent = "Workout complete";
  document.getElementById("timer-label").textContent = "Nice work";
  document.getElementById("timer-value").textContent = "✓";
  document.getElementById("ring-progress").style.strokeDashoffset = 0;
  document.getElementById("timer-ring-container").classList.remove("breathing");
  document.querySelectorAll("#muscle-diagram .body-svg").forEach((svg) => svg.classList.remove("glowing"));
  document.getElementById("mission-title").textContent = "🏁 MISSION COMPLETE";
  document.getElementById("mission-line").textContent = "Every door unlocked. Well done.";
  document.getElementById("mission-progress-fill").style.width = "100%";
  renderMuscleDiagram([]);
  updateTimerControls();
  updateWorkoutsToday();
}

document.getElementById("timer-start-btn").addEventListener("click", () => {
  startCurrentTimer();
});

document.getElementById("timer-easy-btn").addEventListener("click", () => {
  clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.timerRunning = false;
  state.timerPaused = false;
  const ex = state.workoutQueue[state.workoutIndex];
  if (!ex) return;
  if (!state.isResting) state.restAdjustSeconds = -5; // felt easy → shorter recovery next
  advanceWorkout(ex, state.isResting ? "rest" : "work");
});

document.getElementById("timer-hard-btn").addEventListener("click", () => {
  clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.timerRunning = false;
  state.timerPaused = false;
  const ex = state.workoutQueue[state.workoutIndex];
  if (!ex) return;
  if (!state.isResting) state.restAdjustSeconds = 15; // felt hard → longer recovery next
  advanceWorkout(ex, state.isResting ? "rest" : "work");
});

document.getElementById("timer-pause-btn").addEventListener("click", () => {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
    state.timerRunning = false;
    state.timerPaused = true;
    updateTimerControls();
    return;
  }
  if (state.timerPaused) {
    state.timerPaused = false;
    startCurrentTimer();
    return;
  }
  startCurrentTimer();
});

// ---------------------------------------------------------------------------
// Live camera muscle tracking — client-side only, nothing is ever uploaded.
// Uses a real pose-detection model (TensorFlow.js MoveNet) to find body
// joints in the camera feed, then glows the region of whichever muscle(s)
// the current exercise targets, directly on your own video. Front-facing
// camera means back-of-body muscles (triceps vs biceps, hamstrings vs
// quads, lats/back) can't be told apart visually — those pairs share an
// approximate on-screen position honestly rather than pretending precision
// we don't have.
// ---------------------------------------------------------------------------
let auraStream = null;
let auraRAF = null;
let auraDetector = null;

const MUSCLE_KEYPOINTS = {
  shoulders: ["left_shoulder", "right_shoulder"],
  chest: ["__chest"],
  biceps: ["__upperarm_l", "__upperarm_r"],
  triceps: ["__upperarm_l", "__upperarm_r"],
  forearms: ["__forearm_l", "__forearm_r"],
  abs: ["__torso_center"],
  obliques: ["__oblique_l", "__oblique_r"],
  quads: ["__thigh_l", "__thigh_r"],
  hamstrings: ["__thigh_l", "__thigh_r"],
  calves: ["__shin_l", "__shin_r"],
  glutes: ["__hips"],
  lats: ["__oblique_l", "__oblique_r"],
  upper_back: ["__chest"],
  lower_back: ["__torso_center"],
  traps: ["left_shoulder", "right_shoulder"],
};

function mid(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, score: Math.min(a.score, b.score) };
}

function computeMusclePoints(kpMap, muscleKey) {
  const ls = kpMap.left_shoulder, rs = kpMap.right_shoulder;
  const lh = kpMap.left_hip, rh = kpMap.right_hip;
  const le = kpMap.left_elbow, re = kpMap.right_elbow;
  const lw = kpMap.left_wrist, rw = kpMap.right_wrist;
  const lk = kpMap.left_knee, rk = kpMap.right_knee;
  const la = kpMap.left_ankle, ra = kpMap.right_ankle;

  const shoulderMid = mid(ls, rs);
  const hipMid = mid(lh, rh);
  const torsoCenter = mid(shoulderMid, hipMid);

  const derived = {
    __chest: torsoCenter && shoulderMid ? mid(shoulderMid, torsoCenter) : null,
    __torso_center: torsoCenter,
    __hips: hipMid,
    __oblique_l: lh && torsoCenter ? mid(lh, torsoCenter) : null,
    __oblique_r: rh && torsoCenter ? mid(rh, torsoCenter) : null,
    __upperarm_l: mid(ls, le),
    __upperarm_r: mid(rs, re),
    __forearm_l: mid(le, lw),
    __forearm_r: mid(re, rw),
    __thigh_l: mid(lh, lk),
    __thigh_r: mid(rh, rk),
    __shin_l: mid(lk, la),
    __shin_r: mid(rk, ra),
    left_shoulder: ls, right_shoulder: rs,
  };

  return (MUSCLE_KEYPOINTS[muscleKey] || [])
    .map((k) => derived[k])
    .filter((p) => p && p.score > 0.3);
}

async function startAura() {
  const video = document.getElementById("aura-video");
  const note = document.getElementById("aura-note");

  if (typeof poseDetection === "undefined" || typeof tf === "undefined") {
    note.textContent = "Pose tracking failed to load — check your connection.";
    return false;
  }

  try {
    auraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
  } catch (err) {
    note.textContent = "Camera permission denied or unavailable.";
    return false;
  }
  video.srcObject = auraStream;
  document.getElementById("aura-wrap").style.display = "block";
  note.textContent = "Loading pose model…";

  try {
    await tf.ready();
    auraDetector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    });
  } catch (err) {
    note.textContent = "Could not load pose model.";
    stopAura();
    return false;
  }

  note.textContent = "Tracking…";
  auraLoop();
  return true;
}

function stopAura() {
  if (auraRAF) cancelAnimationFrame(auraRAF);
  auraRAF = null;
  if (auraStream) {
    auraStream.getTracks().forEach((t) => t.stop());
    auraStream = null;
  }
  auraDetector = null;
  document.getElementById("aura-wrap").style.display = "none";
  document.getElementById("aura-toggle-btn").classList.remove("active");
}

async function auraLoop() {
  const video = document.getElementById("aura-video");
  const canvas = document.getElementById("aura-canvas");
  const ctx = canvas.getContext("2d");

  if (video.readyState >= 2 && auraDetector) {
    const poses = await auraDetector.estimatePoses(video);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (poses.length) {
      const scaleX = canvas.width / video.videoWidth;
      const scaleY = canvas.height / video.videoHeight;
      const kpMap = {};
      poses[0].keypoints.forEach((k) => {
        kpMap[k.name] = { x: k.x * scaleX, y: k.y * scaleY, score: k.score };
      });

      const ex = state.workoutQueue[state.workoutIndex];
      const targetMuscles = ex && !state.isResting ? ex.muscles || [] : [];
      const seen = new Set();

      targetMuscles.forEach((muscle) => {
        computeMusclePoints(kpMap, muscle).forEach((pt) => {
          const key = Math.round(pt.x) + "," + Math.round(pt.y);
          if (seen.has(key)) return; // avoid double-drawing overlapping muscle pairs
          seen.add(key);
          const grad = ctx.createRadialGradient(pt.x, pt.y, 2, pt.x, pt.y, 34);
          grad.addColorStop(0, "rgba(199,244,100,0.85)");
          grad.addColorStop(1, "rgba(199,244,100,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 34, 0, Math.PI * 2);
          ctx.fill();
        });
      });

      const note = document.getElementById("aura-note");
      note.textContent = targetMuscles.length ? "Tracking: " + targetMuscles.join(", ") : "Tracking…";
    }
  }

  auraRAF = requestAnimationFrame(auraLoop);
}

document.getElementById("aura-toggle-btn").addEventListener("click", async (e) => {
  if (auraStream) {
    stopAura();
    return;
  }
  e.target.classList.add("active");
  const ok = await startAura();
  if (!ok) e.target.classList.remove("active");
});

document.getElementById("timer-exit-btn").addEventListener("click", () => {
  clearInterval(state.timerHandle);
  stopAura();
  showScreen("screen-dashboard");
});

// ---------------------------------------------------------------------------
// Search / trends
// ---------------------------------------------------------------------------
let searchDebounce;
document.getElementById("search-input").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(e.target.value), 250);
});

async function runSearch(q) {
  const { data } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (!data.ok) return;
  const resWrap = document.getElementById("search-results");
  resWrap.innerHTML = "";
  data.results.forEach((ex) => {
    const card = document.createElement("div");
    card.className = "exercise-card";
    card.innerHTML = `
      <div class="exercise-meta">
        <span class="exercise-dot" style="background:${state.categories[ex.category]?.color || '#C7F464'}"></span>
        <div><div class="exercise-name">${ex.name}</div><div class="exercise-sub">${ex.category_label}</div></div>
      </div>
      <div class="exercise-go">→</div>`;
    card.addEventListener("click", () => startWorkout(ex.category, [ex]));
    resWrap.appendChild(card);
  });

  const trendWrap = document.getElementById("trend-results");
  trendWrap.innerHTML = "";
  data.trending.forEach((t) => {
    const tag = document.createElement("div");
    tag.className = "exercise-card";
    tag.innerHTML = `<div class="exercise-meta"><div><span class="trend-tag">↑ ${t.tag}</span><div class="exercise-name">${t.name}</div></div></div>`;
    trendWrap.appendChild(tag);
  });
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
async function refreshAfterPlanChange() {
  const { data } = await api("/api/me");
  if (data.ok) state.user = data.user;
  await Promise.all([loadExercises(), loadFoodDatabase()]);
  renderAccountScreen();
}

function renderPlanCards(plans) {
  const wrap = document.getElementById("plans-list");
  wrap.innerHTML = "";
  plans.forEach((p) => {
    const card = document.createElement("div");
    card.className = "plan-card" + (p.id === "premium" ? " recommended" : "");
    card.innerHTML = `
      ${p.id === "premium" ? '<div class="plan-badge">Most popular</div>' : ""}
      <div class="plan-name">${p.name}</div>
      <div class="plan-price">${p.price_display}<span> / ${p.period}</span></div>
      <ul class="plan-features">${p.features.map((f) => `<li>${f}</li>`).join("")}</ul>
      <button class="btn ${p.id === "free" ? "btn-ghost" : "btn-primary"}" style="margin-top:16px;">
        ${p.id === "free" ? "Current plan" : "Choose " + p.name}
      </button>`;
    card.querySelector("button").addEventListener("click", async () => {
      if (p.id === "free") {
        const { data: subData } = await api("/api/subscribe", { method: "POST", body: { plan: p.id, price: 0, currency: p.currency } });
        if (subData.ok) {
          flash("plan-status", `You're on ${p.name}.`, "success");
          await refreshAfterPlanChange();
        }
        return;
      }

      const amountPaisa = Math.round(Number(p.amount) * 100);
      const { data: orderData } = await api("/api/create-order", {
        method: "POST",
        body: { amount: amountPaisa, currency: p.currency, receipt: `fitpulse-${p.id}-${Date.now()}` },
      });
      if (!orderData.ok) {
        flash("plan-status", orderData.error || "Could not start checkout.", "error");
        return;
      }

      if (!orderData.key_id || !window.Razorpay) {
        flash("plan-status", "Checkout could not be started from this origin. Please test on HTTPS or a deployed domain with a valid Razorpay key pair.", "error");
        return;
      }

      const options = {
        key: orderData.key_id,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "FitPulse",
        description: `${p.name} subscription`,
        order_id: orderData.order_id,
        handler: async function (response) {
          const { data: verifyData } = await api("/api/verify-payment", {
            method: "POST",
            body: {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              plan: p.id,
              price: p.amount,
              currency: p.currency,
            },
          });
          if (verifyData.ok) {
            flash("plan-status", `Payment verified — subscribed to ${p.name}.`, "success");
            await refreshAfterPlanChange();
          } else {
            flash("plan-status", verifyData.error || "Payment could not be verified.", "error");
          }
        },
        prefill: { email: state.user?.identifier || "" },
        theme: { color: "#8B7BFF" },
        modal: {
          ondismiss: () => {
            flash("plan-status", "Payment was cancelled in the Razorpay popup.", "error");
          },
        },
      };

      try {
        const razorpay = new window.Razorpay(options);
        razorpay.on("payment.failed", function (response) {
          flash("plan-status", response.error?.description || "Payment failed in the Razorpay modal.", "error");
        });
        razorpay.open();
      } catch (err) {
        flash("plan-status", "Razorpay checkout could not open from this browser session.", "error");
      }
    });
    wrap.appendChild(card);
  });
}

async function loadPlans() {
  const country = state.user?.country || "IN";
  const { data } = await api(`/api/plans?country=${country}`);
  if (!data.ok) return;
  renderPlanCards(data.plans);
}

document.getElementById("plan-country-select").addEventListener("change", (e) => {
  state.country = e.target.value;
  loadPlansForCountry(e.target.value);
});

async function loadPlansForCountry(country) {
  const { data } = await api(`/api/plans?country=${country}`);
  if (!data.ok) return;
  state.user = state.user || {};
  renderPlanCards(data.plans);
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  state.identifier = null;
  location.reload();
});
