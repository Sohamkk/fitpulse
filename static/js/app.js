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
  country: "IN",
  editingProfile: false,
  foodCategories: null,
  activeFoodCategory: null,
  foodLogToday: [],
  caloriesBurnedToday: 0,
  dietLocked: false,
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
  await Promise.all([loadCalculatorResult(), loadExercises(), loadPlans(), updateWorkoutsToday(), loadFoodDatabase()]);
  renderDietSummary();
  renderAccountScreen();
  showScreen("screen-dashboard");
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
}

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
  list.innerHTML = "";
  const startAllBtn = document.getElementById("start-category-btn");

  if (cat.locked) {
    list.innerHTML = `
      <div class="upgrade-prompt">
        <div class="upgrade-prompt-title">🔒 ${cat.label} is a Premium category</div>
        <p class="subtext">Upgrade to unlock all 13 workout categories, including ${cat.label}.</p>
        <button class="btn btn-primary" id="upgrade-from-exercises-btn">See plans</button>
      </div>`;
    document.getElementById("upgrade-from-exercises-btn").addEventListener("click", () => showScreen("screen-plans"));
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
          <div class="exercise-sub">${ex.duration}s work · ${ex.rest}s rest · ~${estCalories(ex)} kcal</div>
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

function startWorkout(catKey, items) {
  state.workoutQueue = items.map((it) => ({ ...it, category: catKey }));
  state.workoutIndex = 0;
  showScreen("screen-timer");
  renderTimerDots();
  runStep(state.workoutQueue[0], "work");
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

function runStep(exercise, phase) {
  clearInterval(state.timerHandle);
  const duration = phase === "work" ? exercise.duration : exercise.rest;
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

  updateRing();

  state.timerHandle = setInterval(() => {
    state.timerSeconds -= 1;
    updateRing();
    if (state.timerSeconds <= 0) {
      clearInterval(state.timerHandle);
      advanceWorkout(exercise, phase);
    }
  }, 1000);
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
    // log calories burned for this segment
    api("/api/log-workout", {
      method: "POST",
      body: { exercise_name: exercise.name, category: exercise.category, duration_sec: exercise.duration, met: exercise.met },
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
  document.getElementById("timer-exercise-name").textContent = "Workout complete";
  document.getElementById("timer-label").textContent = "Nice work";
  document.getElementById("timer-value").textContent = "✓";
  document.getElementById("ring-progress").style.strokeDashoffset = 0;
  document.getElementById("timer-ring-container").classList.remove("breathing");
  renderMuscleDiagram([]);
  updateWorkoutsToday();
}

document.getElementById("timer-skip-btn").addEventListener("click", () => {
  clearInterval(state.timerHandle);
  const ex = state.workoutQueue[state.workoutIndex];
  if (!ex) return;
  advanceWorkout(ex, state.isResting ? "rest" : "work");
});

document.getElementById("timer-pause-btn").addEventListener("click", (e) => {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
    e.target.textContent = "▶";
  } else {
    const ex = state.workoutQueue[state.workoutIndex];
    state.timerHandle = setInterval(() => {
      state.timerSeconds -= 1;
      updateRing();
      if (state.timerSeconds <= 0) { clearInterval(state.timerHandle); advanceWorkout(ex, state.isResting ? "rest" : "work"); }
    }, 1000);
    e.target.textContent = "⏸";
  }
});

document.getElementById("timer-exit-btn").addEventListener("click", () => {
  clearInterval(state.timerHandle);
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
    card.querySelector("button").addEventListener("click", () => startPlanCheckout(p));
    wrap.appendChild(card);
  });
}

async function startPlanCheckout(p) {
  // Only the plan id (and, for paid plans, the country already baked into
  // p.currency via /api/plans) is ever sent — price/currency are computed
  // server-side from BASE_PLANS/COUNTRY_PRICING and never trusted from here.
  if (p.id === "free") {
    const { data: subData } = await api("/api/subscribe", { method: "POST", body: { plan: p.id } });
    if (subData.ok) {
      flash("plan-status", `You're on ${p.name}.`, "success");
      await refreshAfterPlanChange();
    } else {
      flash("plan-status", subData.error || "Could not switch plans.", "error");
    }
    return;
  }

  const { data: subData } = await api("/api/subscribe", { method: "POST", body: { plan: p.id } });
  if (!subData.ok) {
    flash("plan-status", subData.error || "Could not start checkout.", "error");
    return;
  }

  if (!subData.razorpay_key_id || !window.Razorpay) {
    flash("plan-status", "Checkout is not configured yet. Your plan change was recorded locally.", "success");
    return;
  }

  const options = {
    key: subData.razorpay_key_id,
    amount: subData.order.amount,
    currency: subData.order.currency,
    name: "FitPulse",
    description: `${p.name} subscription`,
    order_id: subData.order.id,
    handler: async function (response) {
      const { data: verifyData } = await api("/api/verify-payment", {
        method: "POST",
        body: {
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        },
      });
      if (verifyData.ok) {
        flash("plan-status", verifyData.message || `Payment verified — subscribed to ${p.name}.`, "success");
        await refreshAfterPlanChange();
      } else {
        flash("plan-status", verifyData.error || "Payment could not be verified.", "error");
      }
    },
    modal: {
      // Fires when the user closes the checkout popup without paying.
      ondismiss: function () {
        flash("plan-status", "Checkout cancelled — no payment was made.", "error");
      },
    },
    prefill: { email: state.user?.identifier || "" },
    theme: { color: "#8B7BFF" },
  };

  const razorpay = new window.Razorpay(options);
  razorpay.on("payment.failed", function (response) {
    flash("plan-status", response.error?.description || "Payment failed. Please try again.", "error");
  });
  razorpay.open();
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
