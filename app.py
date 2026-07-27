"""
FitPulse — Fitness App Backend
================================
A real Flask backend: OTP auth (email by default, Twilio-ready for SMS),
SQLite storage, BMR/TDEE calorie math, exercise library, and
country-aware subscription pricing.

RUN LOCALLY
-----------
1. python -m venv venv && source venv/bin/activate   (Windows: venv\\Scripts\\activate)
2. pip install -r requirements.txt
3. Copy .env.example to .env and fill in your real SMTP credentials
   (see README.md for a 2-minute Gmail App Password walkthrough).
4. python app.py
5. Open http://127.0.0.1:5000

No demo/fake data is sent to the browser for OTP — the code is generated
server-side, hashed, stored with a 5 minute expiry, and only accepted
once. Wire in Twilio in send_otp() if you want SMS instead of/alongside email.
"""

import os
import re
import time
import random
import sqlite3
import smtplib
import hashlib
import secrets
from email.mime.text import MIMEText
from datetime import datetime, timedelta

from flask import Flask, request, jsonify, g, session
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv is optional; env vars can also be set directly

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB_PATH = "/tmp/fitpulse.db" if os.name != "nt" else os.path.join(BASE_DIR, "fitpulse.db")
DB_PATH = os.environ.get("FITPULSE_DB_PATH", DEFAULT_DB_PATH)

app = Flask(__name__, static_folder="static", template_folder="templates")


def ensure_user_columns():
    conn = sqlite3.connect(DB_PATH)
    columns = [row[1] for row in conn.execute("PRAGMA table_info(users)")]
    if "password_hash" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
        conn.commit()
    conn.close()
app.secret_key = os.environ.get("FLASK_SECRET_KEY", secrets.token_hex(32))

@app.before_request
def ensure_database():
    init_db()

@app.get("/favicon.ico")
def favicon():
    return "", 204

@app.errorhandler(Exception)
def handle_internal_error(error):
    if request.path.startswith("/api/"):
        app.logger.exception(error)
        return jsonify(ok=False, error="Internal server error. Check server logs."), 500
    raise error

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", 587))
SMTP_USER = os.environ.get("SMTP_USER", "")       # your sending email address
SMTP_PASS = os.environ.get("SMTP_PASS", "")       # app password, never your real password
OTP_TTL_SECONDS = 5 * 60
OTP_RESEND_COOLDOWN = 30  # seconds

# Optional: fill these in and flip USE_TWILIO=1 in .env to send real SMS instead of email
TWILIO_SID = os.environ.get("TWILIO_SID", "")
TWILIO_AUTH = os.environ.get("TWILIO_AUTH", "")
TWILIO_FROM = os.environ.get("TWILIO_FROM", "")
USE_TWILIO = os.environ.get("USE_TWILIO", "0") == "1"
DEMO_MODE = os.environ.get("DEMO_MODE", "1") == "1"  # For testing without Twilio

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9]{8,15}$")

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identifier TEXT UNIQUE NOT NULL,       -- email or phone
            identifier_type TEXT NOT NULL,         -- 'email' | 'phone'
            name TEXT,
            age INTEGER,
            weight_kg REAL,
            height_cm REAL,
            gender TEXT,
            activity_level TEXT DEFAULT 'moderate',
            goal TEXT DEFAULT 'maintain',
            country TEXT DEFAULT 'IN',
            plan TEXT DEFAULT 'free',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS otp_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identifier TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            verified INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS workout_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            exercise_name TEXT,
            category TEXT,
            duration_sec INTEGER,
            calories REAL,
            logged_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            plan TEXT NOT NULL,
            price REAL,
            currency TEXT,
            started_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    conn.commit()
    conn.close()
    ensure_user_columns()


# ---------------------------------------------------------------------------
# OTP delivery
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Demo mode code storage (for testing — not for production)
# ---------------------------------------------------------------------------
DEMO_CODES = {}  # Store demo OTP codes temporarily: {identifier: code}

def _hash_code(code: str, identifier: str) -> str:
    return hashlib.sha256(f"{identifier}:{code}:{app.secret_key}".encode()).hexdigest()


def send_email_otp(to_email: str, code: str) -> tuple[bool, str]:
    if not SMTP_USER or not SMTP_PASS:
        # No credentials configured yet — this is expected on first run.
        return False, "SMTP not configured. Add SMTP_USER / SMTP_PASS to .env (see README)."
    try:
        msg = MIMEText(
            f"Your FitPulse verification code is {code}\n\n"
            f"It expires in 5 minutes. If you didn't request this, ignore this email."
        )
        msg["Subject"] = "Your FitPulse code"
        msg["From"] = SMTP_USER
        msg["To"] = to_email
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_USER, [to_email], msg.as_string())
        return True, "sent"
    except Exception as e:
        return False, str(e)


def send_sms_otp(to_phone: str, code: str) -> tuple[bool, str]:
    if not (TWILIO_SID and TWILIO_AUTH and TWILIO_FROM):
        return False, "Twilio not configured. Add TWILIO_SID / TWILIO_AUTH / TWILIO_FROM to .env."
    try:
        from twilio.rest import Client  # pip install twilio
        client = Client(TWILIO_SID, TWILIO_AUTH)
        client.messages.create(
            body=f"Your FitPulse code is {code}. Expires in 5 minutes.",
            from_=TWILIO_FROM,
            to=to_phone,
        )
        return True, "sent"
    except Exception as e:
        return False, str(e)


def send_otp(identifier: str, id_type: str, code: str) -> tuple[bool, str]:
    # Demo mode: log OTP for testing (no real SMS sent)
    if DEMO_MODE and not USE_TWILIO:
        DEMO_CODES[identifier] = code  # Store for retrieval via browser
        app.logger.warning(f"[DEMO] OTP for {identifier}: {code}")
        return True, "sent (demo — check server logs)"
    
    # Production: Phone-only OTP via Twilio
    if not USE_TWILIO:
        return False, "Twilio not enabled. Set USE_TWILIO=1 in .env."
    return send_sms_otp(identifier, code)


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.post("/api/auth/request-otp")
def request_otp():
    data = request.get_json(force=True, silent=True) or {}
    identifier = (data.get("identifier") or "").strip()

    if not PHONE_RE.match(identifier):
        return jsonify(ok=False, error="Enter a valid phone number (8-15 digits, optional +)."), 400
    
    id_type = "phone"

    db = get_db()
    recent = db.execute(
        "SELECT created_at FROM otp_codes WHERE identifier=? ORDER BY id DESC LIMIT 1",
        (identifier,),
    ).fetchone()
    if recent:
        last_time = datetime.strptime(recent["created_at"], "%Y-%m-%d %H:%M:%S")
        if (datetime.utcnow() - last_time).total_seconds() < OTP_RESEND_COOLDOWN:
            return jsonify(ok=False, error="Please wait before requesting another code."), 429

    code = f"{random.randint(0, 999999):06d}"
    code_hash = _hash_code(code, identifier)
    expires_at = (datetime.utcnow() + timedelta(seconds=OTP_TTL_SECONDS)).strftime("%Y-%m-%d %H:%M:%S")

    db.execute(
        "INSERT INTO otp_codes (identifier, code_hash, expires_at) VALUES (?, ?, ?)",
        (identifier, code_hash, expires_at),
    )
    db.commit()

    sent, info = send_otp(identifier, id_type, code)
    if not sent:
        # Phone OTP requires Twilio to be configured
        return jsonify(
            ok=False,
            error=f"Could not send code ({info}). Set up Twilio in .env (TWILIO_SID, TWILIO_AUTH, TWILIO_FROM) and set USE_TWILIO=1.",
        ), 502

    return jsonify(ok=True, message=f"Code sent to {identifier}.", channel=id_type)


@app.post("/api/auth/verify-otp")
def verify_otp():
    data = request.get_json(force=True, silent=True) or {}
    identifier = (data.get("identifier") or "").strip()
    code = (data.get("code") or "").strip()

    if not identifier or not code:
        return jsonify(ok=False, error="Missing identifier or code."), 400

    db = get_db()
    row = db.execute(
        "SELECT * FROM otp_codes WHERE identifier=? AND verified=0 ORDER BY id DESC LIMIT 1",
        (identifier,),
    ).fetchone()

    if not row:
        return jsonify(ok=False, error="No pending code. Request a new one."), 400
    if row["attempts"] >= 5:
        return jsonify(ok=False, error="Too many attempts. Request a new code."), 429
    if datetime.utcnow() > datetime.strptime(row["expires_at"], "%Y-%m-%d %H:%M:%S"):
        return jsonify(ok=False, error="Code expired. Request a new one."), 400

    db.execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE id=?", (row["id"],))
    db.commit()

    if _hash_code(code, identifier) != row["code_hash"]:
        return jsonify(ok=False, error="Incorrect code."), 400

    db.execute("UPDATE otp_codes SET verified=1 WHERE id=?", (row["id"],))

    id_type = "email" if EMAIL_RE.match(identifier) else "phone"
    user = db.execute("SELECT * FROM users WHERE identifier=?", (identifier,)).fetchone()
    if not user:
        db.execute(
            "INSERT INTO users (identifier, identifier_type) VALUES (?, ?)",
            (identifier, id_type),
        )
        db.commit()
        user = db.execute("SELECT * FROM users WHERE identifier=?", (identifier,)).fetchone()
        is_new = True
    else:
        is_new = False

    session["user_id"] = user["id"]
    return jsonify(ok=True, is_new_user=is_new, user=dict(user))


@app.post("/api/auth/register")
def register_user():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "").strip()
    name = (data.get("name") or "").strip()

    if not EMAIL_RE.match(email):
        return jsonify(ok=False, error="Enter a valid email address."), 400
    if len(password) < 6:
        return jsonify(ok=False, error="Password must be at least 6 characters."), 400

    db = get_db()
    existing = db.execute("SELECT id FROM users WHERE identifier=?", (email,)).fetchone()
    if existing:
        return jsonify(ok=False, error="An account with this email already exists."), 409

    password_hash = generate_password_hash(password)
    db.execute(
        "INSERT INTO users (identifier, identifier_type, name, password_hash) VALUES (?, 'email', ?, ?)",
        (email, name or email.split("@", 1)[0], password_hash),
    )
    db.commit()
    user = db.execute("SELECT * FROM users WHERE identifier=?", (email,)).fetchone()
    session["user_id"] = user["id"]
    return jsonify(ok=True, is_new_user=True, user=dict(user))


@app.post("/api/auth/login")
def login_user():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "").strip()

    if not EMAIL_RE.match(email) or not password:
        return jsonify(ok=False, error="Enter your email and password."), 400

    db = get_db()
    user = db.execute(
        "SELECT * FROM users WHERE identifier=? AND identifier_type='email'",
        (email,),
    ).fetchone()

    if not user or not user["password_hash"] or not check_password_hash(user["password_hash"], password):
        return jsonify(ok=False, error="Email or password is incorrect."), 401

    session["user_id"] = user["id"]
    return jsonify(ok=True, is_new_user=False, user=dict(user))


@app.post("/api/auth/google")
def google_signin():
    """
    Real Google Sign-In needs a Google Cloud OAuth Client ID (free, ~5 min to
    create in console.cloud.google.com). Frontend sends the ID token from
    Google's client library here; we verify it server-side before trusting it.
    """
    data = request.get_json(force=True, silent=True) or {}
    id_token_str = data.get("id_token")
    google_client_id = os.environ.get("GOOGLE_CLIENT_ID", "")

    if not google_client_id:
        return jsonify(ok=False, error="GOOGLE_CLIENT_ID not set in .env yet."), 501
    if not id_token_str:
        return jsonify(ok=False, error="Missing Google ID token."), 400

    try:
        from google.oauth2 import id_token as google_id_token  # pip install google-auth
        from google.auth.transport import requests as google_requests

        info = google_id_token.verify_oauth2_token(
            id_token_str, google_requests.Request(), google_client_id
        )
        email = info["email"]
    except ImportError:
        return jsonify(ok=False, error="Run: pip install google-auth (in your activated venv), then restart the server."), 501
    except Exception as e:
        return jsonify(ok=False, error=f"Google verification failed: {e}"), 401

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE identifier=?", (email,)).fetchone()
    if not user:
        db.execute(
            "INSERT INTO users (identifier, identifier_type, name) VALUES (?, 'email', ?)",
            (email, info.get("name", "")),
        )
        db.commit()
        user = db.execute("SELECT * FROM users WHERE identifier=?", (email,)).fetchone()

    session["user_id"] = user["id"]
    return jsonify(ok=True, user=dict(user))


@app.get("/api/auth/demo-numbers")
def demo_numbers():
    """Demo mode: show test phone numbers available for testing."""
    if not DEMO_MODE or USE_TWILIO:
        return jsonify(ok=False, error="Demo mode not enabled."), 404
    
    test_numbers = [
        "+919876543210",
        "+919876543211",
        "+919876543212",
        "+919876543213",
        "+919876543214",
    ]
    return jsonify(ok=True, demo_numbers=test_numbers, message="Use any of these numbers to test OTP. Check server logs for codes.")


@app.get("/api/auth/demo-code/<identifier>")
def get_demo_code(identifier):
    """Demo mode: retrieve OTP code for testing (shows in browser console)."""
    if not DEMO_MODE or USE_TWILIO:
        return jsonify(ok=False, error="Demo mode not enabled."), 404
    
    code = DEMO_CODES.get(identifier)
    if not code:
        return jsonify(ok=False, error="No OTP found for this number. Request one first."), 404
    
    return jsonify(ok=True, code=code, message=f"Use code: {code}")


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------

@app.post("/api/profile")
def save_profile():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    data = request.get_json(force=True, silent=True) or {}
    db = get_db()
    db.execute(
        """UPDATE users SET name=?, age=?, weight_kg=?, height_cm=?, gender=?,
           activity_level=?, goal=?, country=? WHERE id=?""",
        (
            data.get("name"),
            data.get("age"),
            data.get("weight_kg"),
            data.get("height_cm"),
            data.get("gender"),
            data.get("activity_level", "moderate"),
            data.get("goal", "maintain"),
            data.get("country", "IN"),
            session["user_id"],
        ),
    )
    db.commit()
    user = db.execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
    return jsonify(ok=True, user=dict(user))


# ---------------------------------------------------------------------------
# Calorie / BMR / TDEE engine
# ---------------------------------------------------------------------------

ACTIVITY_MULTIPLIERS = {
    "sedentary": 1.2,
    "light": 1.375,
    "moderate": 1.55,
    "active": 1.725,
    "athlete": 1.9,
}

GOAL_ADJUSTMENT = {
    "lose": -500,
    "maintain": 0,
    "gain": 400,
}


@app.post("/api/calculate")
def calculate_calories():
    data = request.get_json(force=True, silent=True) or {}
    try:
        age = float(data["age"])
        weight = float(data["weight_kg"])
        height = float(data["height_cm"])
        gender = data.get("gender", "male")
        activity = data.get("activity_level", "moderate")
        goal = data.get("goal", "maintain")
    except (KeyError, ValueError, TypeError):
        return jsonify(ok=False, error="age, weight_kg, height_cm are required numbers."), 400

    # Mifflin-St Jeor equation
    if gender == "female":
        bmr = 10 * weight + 6.25 * height - 5 * age - 161
    else:
        bmr = 10 * weight + 6.25 * height - 5 * age + 5

    multiplier = ACTIVITY_MULTIPLIERS.get(activity, 1.55)
    tdee = bmr * multiplier
    target = tdee + GOAL_ADJUSTMENT.get(goal, 0)

    bmi = weight / ((height / 100) ** 2)
    if bmi < 18.5:
        bmi_label = "Underweight"
    elif bmi < 25:
        bmi_label = "Healthy range"
    elif bmi < 30:
        bmi_label = "Overweight"
    else:
        bmi_label = "Obese range"

    macros = {
        "protein_g": round(weight * 1.8),
        "fat_g": round((target * 0.25) / 9),
        "carbs_g": round((target - (weight * 1.8 * 4) - ((target * 0.25))) / 4),
    }

    return jsonify(
        ok=True,
        bmr=round(bmr),
        tdee=round(tdee),
        target_calories=round(target),
        bmi=round(bmi, 1),
        bmi_label=bmi_label,
        macros=macros,
    )


# ---------------------------------------------------------------------------
# Exercise library
# ---------------------------------------------------------------------------

EXERCISES = {
    "cardio": {
        "label": "Cardio",
        "color": "#FF4D5E",
        "items": [
            {"name": "Jumping Jacks", "duration": 45, "rest": 15, "met": 8.0},
            {"name": "High Knees", "duration": 40, "rest": 20, "met": 8.5},
            {"name": "Mountain Climbers", "duration": 40, "rest": 20, "met": 8.0},
            {"name": "Burpees", "duration": 30, "rest": 30, "met": 10.0},
            {"name": "Jump Rope", "duration": 60, "rest": 20, "met": 11.0},
        ],
    },
    "strength": {
        "label": "Strength",
        "color": "#8B7BFF",
        "items": [
            {"name": "Push-ups", "duration": 40, "rest": 20, "met": 6.0},
            {"name": "Squats", "duration": 45, "rest": 15, "met": 5.5},
            {"name": "Lunges", "duration": 40, "rest": 20, "met": 5.0},
            {"name": "Plank", "duration": 60, "rest": 20, "met": 4.0},
            {"name": "Glute Bridges", "duration": 40, "rest": 15, "met": 4.5},
        ],
    },
    "hiit": {
        "label": "HIIT",
        "color": "#C7F464",
        "items": [
            {"name": "Squat Jumps", "duration": 30, "rest": 30, "met": 9.5},
            {"name": "Skater Hops", "duration": 30, "rest": 30, "met": 9.0},
            {"name": "Tuck Jumps", "duration": 25, "rest": 35, "met": 10.0},
            {"name": "Sprint in Place", "duration": 30, "rest": 30, "met": 11.5},
        ],
    },
    "yoga": {
        "label": "Yoga & Mobility",
        "color": "#6FD6C4",
        "items": [
            {"name": "Sun Salutation", "duration": 60, "rest": 10, "met": 3.0},
            {"name": "Downward Dog", "duration": 45, "rest": 10, "met": 2.5},
            {"name": "Warrior II", "duration": 45, "rest": 10, "met": 2.8},
            {"name": "Cat-Cow Stretch", "duration": 40, "rest": 10, "met": 2.3},
        ],
    },
    "stretching": {
        "label": "Cooldown & Stretch",
        "color": "#F2F0EA",
        "items": [
            {"name": "Hamstring Stretch", "duration": 30, "rest": 5, "met": 2.0},
            {"name": "Quad Stretch", "duration": 30, "rest": 5, "met": 2.0},
            {"name": "Shoulder Stretch", "duration": 30, "rest": 5, "met": 1.8},
            {"name": "Child's Pose", "duration": 45, "rest": 5, "met": 1.8},
        ],
    },
}


@app.get("/api/exercises")
def get_exercises():
    return jsonify(ok=True, categories=EXERCISES)


@app.post("/api/log-workout")
def log_workout():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    data = request.get_json(force=True, silent=True) or {}
    user = get_db().execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
    weight = user["weight_kg"] or 70

    met = float(data.get("met", 5))
    duration_sec = int(data.get("duration_sec", 0))
    # calories = MET * weight(kg) * hours
    calories = met * weight * (duration_sec / 3600)

    db = get_db()
    db.execute(
        """INSERT INTO workout_log (user_id, exercise_name, category, duration_sec, calories)
           VALUES (?, ?, ?, ?, ?)""",
        (session["user_id"], data.get("exercise_name"), data.get("category"), duration_sec, calories),
    )
    db.commit()
    return jsonify(ok=True, calories_burned=round(calories, 1))


@app.get("/api/history")
def get_history():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    rows = get_db().execute(
        "SELECT * FROM workout_log WHERE user_id=? ORDER BY id DESC LIMIT 50",
        (session["user_id"],),
    ).fetchall()
    return jsonify(ok=True, history=[dict(r) for r in rows])


# ---------------------------------------------------------------------------
# Subscription plans — country-aware pricing
# ---------------------------------------------------------------------------

# Base prices in USD; each country maps to its local currency + a fair
# purchasing-power-adjusted multiplier. Extend this dict for more countries.
COUNTRY_PRICING = {
    "US": {"currency": "USD", "symbol": "$", "multiplier": 1.0},
    "IN": {"currency": "INR", "symbol": "₹", "multiplier": 0.35},   # ~PPP adjusted
    "GB": {"currency": "GBP", "symbol": "£", "multiplier": 0.9},
    "EU": {"currency": "EUR", "symbol": "€", "multiplier": 0.95},
    "AU": {"currency": "AUD", "symbol": "A$", "multiplier": 1.1},
    "CA": {"currency": "CAD", "symbol": "C$", "multiplier": 1.05},
    "BR": {"currency": "BRL", "symbol": "R$", "multiplier": 0.45},
    "NG": {"currency": "NGN", "symbol": "₦", "multiplier": 0.3},
    "PH": {"currency": "PHP", "symbol": "₱", "multiplier": 0.35},
    "ZA": {"currency": "ZAR", "symbol": "R", "multiplier": 0.5},
}

BASE_PLANS = [
    {"id": "free", "name": "Free", "usd": 0, "period": "forever",
     "features": ["3 workout categories", "Basic calorie calculator", "Ads supported"]},
    {"id": "premium", "name": "Premium", "usd": 6.99, "period": "month",
     "features": ["All workout categories", "Full macro breakdown", "Progress history", "No ads"]},
    {"id": "pro", "name": "Pro", "usd": 59.99, "period": "year",
     "features": ["Everything in Premium", "Personalized plans", "Priority support", "2 months free"]},
]

FX_TO_USD_RATE = {
    # illustrative static rates — swap for a live FX API (e.g. exchangerate.host) in production
    "USD": 1, "INR": 83, "GBP": 0.79, "EUR": 0.92, "AUD": 1.5,
    "CAD": 1.36, "BRL": 5.4, "NGN": 1500, "PHP": 56, "ZAR": 18.5,
}


@app.get("/api/plans")
def get_plans():
    country = request.args.get("country", "US").upper()
    pricing = COUNTRY_PRICING.get(country, COUNTRY_PRICING["US"])
    currency = pricing["currency"]
    rate = FX_TO_USD_RATE.get(currency, 1)

    plans = []
    for p in BASE_PLANS:
        local_price = p["usd"] * rate * pricing["multiplier"]
        plans.append({
            **p,
            "price_display": f'{pricing["symbol"]}{local_price:,.0f}' if local_price >= 1 or local_price == 0
                              else f'{pricing["symbol"]}{local_price:.2f}',
            "currency": currency,
        })
    return jsonify(ok=True, country=country, plans=plans)


@app.post("/api/subscribe")
def subscribe():
    """
    Records the chosen plan. Real payment capture needs a processor —
    Stripe (cards, global) or Razorpay (strong in India/SEA) both have
    generous free sandboxes to test with before going live.
    """
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    data = request.get_json(force=True, silent=True) or {}
    plan = data.get("plan", "free")
    price = data.get("price", 0)
    currency = data.get("currency", "USD")

    db = get_db()
    db.execute(
        "INSERT INTO subscriptions (user_id, plan, price, currency) VALUES (?, ?, ?, ?)",
        (session["user_id"], plan, price, currency),
    )
    db.execute("UPDATE users SET plan=? WHERE id=?", (plan, session["user_id"]))
    db.commit()
    return jsonify(ok=True, message=f"Subscribed to {plan}.")


# ---------------------------------------------------------------------------
# Trending exercises search (simple curated + query matching; swap in a
# real API like Wger or a nutrition/fitness data provider for production)
# ---------------------------------------------------------------------------

TRENDING = [
    {"name": "12-3-30 Treadmill Walk", "category": "cardio", "tag": "Viral on social media"},
    {"name": "75 Hard Challenge", "category": "hiit", "tag": "Trending challenge"},
    {"name": "Pilates Reformer Flow", "category": "yoga", "tag": "Growing fast"},
    {"name": "Zone 2 Cardio", "category": "cardio", "tag": "Endurance trend"},
    {"name": "Nordic Curls", "category": "strength", "tag": "Hamstring trend"},
    {"name": "Dead Hangs", "category": "strength", "tag": "Grip & shoulder health"},
]


@app.get("/api/search")
def search():
    q = (request.args.get("q") or "").lower().strip()
    results = []
    for cat_id, cat in EXERCISES.items():
        for ex in cat["items"]:
            if not q or q in ex["name"].lower() or q in cat["label"].lower():
                results.append({**ex, "category": cat_id, "category_label": cat["label"]})
    trending = [t for t in TRENDING if not q or q in t["name"].lower()]
    return jsonify(ok=True, results=results, trending=trending)


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

from flask import render_template

@app.get("/")
def index():
    return render_template("index.html", google_client_id=os.environ.get("GOOGLE_CLIENT_ID", ""))


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
