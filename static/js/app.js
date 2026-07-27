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
};

// ---------------------------------------------------------------------------
// Session persistence with localStorage
// ---------------------------------------------------------------------------
function saveSession() {
  localStorage.setItem("fitpulse_user", JSON.stringify(state.user));
  localStorage.setItem("fitpulse_identifier", state.identifier);
}

function restoreSession() {
  const savedUser = localStorage.getItem("fitpulse_user");
  const savedIdentifier = localStorage.getItem("fitpulse_identifier");
  if (savedUser && savedIdentifier) {
    state.user = JSON.parse(savedUser);
    state.identifier = savedIdentifier;
    return true;
  }
  return false;
}

function clearSession() {
  localStorage.removeItem("fitpulse_user");
  localStorage.removeItem("fitpulse_identifier");
  state.user = null;
  state.identifier = null;
}

// ---------------------------------------------------------------------------
// Screen router
// ---------------------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(id);
  el.classList.add("active");
  el.scrollTop = 0;
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.target === id));
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
// Splash → login OR restore session
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  if (restoreSession()) {
    await enterApp();
  } else {
    setTimeout(() => showScreen("screen-login"), 1400);
  }
});

// ---------------------------------------------------------------------------
// Auth: request + verify OTP
// ---------------------------------------------------------------------------
const identifierInput = document.getElementById("identifier-input");
const sendOtpBtn = document.getElementById("send-otp-btn");
const emailInput = document.getElementById("email-input");
const passwordInput = document.getElementById("password-input");
const loginEmailBtn = document.getElementById("login-email-btn");
const registerEmailBtn = document.getElementById("register-email-btn");

sendOtpBtn.addEventListener("click", async () => {
  const identifier = identifierInput.value.trim();
  if (!identifier) return flash("login-status", "Enter your phone number.");

  sendOtpBtn.disabled = true;
  sendOtpBtn.textContent = "Sending…";
  const { data } = await api("/api/auth/request-otp", { method: "POST", body: { identifier } });
  sendOtpBtn.disabled = false;
  sendOtpBtn.textContent = "Send code";

  if (!data.ok) {
    flash("login-status", data.error || "Could not send code.");
    return;
  }
  state.identifier = identifier;
  document.getElementById("otp-target").textContent = identifier;
  document.getElementById("login-status").className = "status-msg";
  showScreen("screen-otp");
  document.querySelector("#otp-boxes input").focus();
  startResendCooldown();
});

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
  saveSession();
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
  saveSession();
  if (data.is_new_user) {
    showScreen("screen-profile-setup");
  } else {
    await enterApp();
  }
});

// OTP box auto-advance
const otpInputs = [...document.querySelectorAll("#otp-boxes input")];
otpInputs.forEach((box, i) => {
  box.addEventListener("input", () => {
    box.value = box.value.replace(/\D/g, "").slice(0, 1);
    if (box.value && otpInputs[i + 1]) otpInputs[i + 1].focus();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !box.value && otpInputs[i - 1]) otpInputs[i - 1].focus();
  });
});

document.getElementById("verify-otp-btn").addEventListener("click", async () => {
  const code = otpInputs.map((b) => b.value).join("");
  if (code.length !== 6) return flash("otp-status", "Enter the 6-digit code.");

  const { data } = await api("/api/auth/verify-otp", {
    method: "POST",
    body: { identifier: state.identifier, code },
  });

  if (!data.ok) return flash("otp-status", data.error || "Verification failed.");

  state.user = data.user;
  saveSession();
  if (data.is_new_user) {
    showScreen("screen-profile-setup");
  } else {
    await enterApp();
  }
});

document.getElementById("resend-otp-btn").addEventListener("click", async () => {
  await api("/api/auth/request-otp", { method: "POST", body: { identifier: state.identifier } });
  flash("otp-status", "New code sent.", "success");
  startResendCooldown();
});

function startResendCooldown() {
  const btn = document.getElementById("resend-otp-btn");
  let t = 30;
  btn.disabled = true;
  const iv = setInterval(() => {
    t -= 1;
    btn.textContent = t > 0 ? `Resend code (${t}s)` : "Resend code";
    if (t <= 0) { clearInterval(iv); btn.disabled = false; }
  }, 1000);
}

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
  saveSession();
  await enterApp();
});

// ---------------------------------------------------------------------------
// Enter main app
// ---------------------------------------------------------------------------
async function enterApp() {
  document.getElementById("nav-bottom").classList.remove("hidden");
  renderGreeting();
  await Promise.all([loadCalculatorResult(), loadExercises(), loadPlans()]);
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

function renderCategoryChips() {
  const wrap = document.getElementById("category-chips");
  wrap.innerHTML = "";
  Object.entries(state.categories).forEach(([key, cat]) => {
    const chip = document.createElement("button");
    chip.className = "category-chip" + (key === state.activeCategory ? " active" : "");
    chip.textContent = cat.label;
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

  const startAllBtn = document.getElementById("start-category-btn");
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
async function loadPlans() {
  const country = state.user?.country || "IN";
  const { data } = await api(`/api/plans?country=${country}`);
  if (!data.ok) return;
  const wrap = document.getElementById("plans-list");
  wrap.innerHTML = "";
  data.plans.forEach((p, i) => {
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
      await api("/api/subscribe", { method: "POST", body: { plan: p.id, price: p.usd, currency: p.currency } });
      flash("plan-status", `You're on ${p.name}. (Wire Stripe/Razorpay in app.py to actually charge cards.)`, "success");
    });
    wrap.appendChild(card);
  });
}

document.getElementById("plan-country-select").addEventListener("change", (e) => {
  state.country = e.target.value;
  loadPlansForCountry(e.target.value);
});

async function loadPlansForCountry(country) {
  const { data } = await api(`/api/plans?country=${country}`);
  if (!data.ok) return;
  state.user = state.user || {};
  const wrap = document.getElementById("plans-list");
  wrap.innerHTML = "";
  data.plans.forEach((p) => {
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
      await api("/api/subscribe", { method: "POST", body: { plan: p.id, price: p.usd, currency: p.currency } });
      flash("plan-status", `You're on ${p.name}. (Wire Stripe/Razorpay in app.py to actually charge cards.)`, "success");
    });
    wrap.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  clearSession();
  location.reload();
});
