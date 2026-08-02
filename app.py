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
import hmac
import random
import sqlite3
import smtplib
import hashlib
import secrets
import logging
import traceback
from email.mime.text import MIMEText
from datetime import datetime, timedelta, date

from flask import Flask, request, jsonify, g, session
from werkzeug.security import generate_password_hash, check_password_hash

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv is optional; env vars can also be set directly

try:
    import razorpay
except ImportError:
    razorpay = None  # payments route will report this clearly instead of crashing

# --- Database backend ---
# Local dev / no DATABASE_URL set -> SQLite file (simple, zero setup).
# DATABASE_URL set (e.g. Vercel's Neon Postgres integration) -> real Postgres,
# which is REQUIRED for data to persist on Vercel: serverless functions have
# a stateless, per-instance /tmp, so a SQLite file there can vanish or differ
# between requests. See README for the 1-minute Vercel Storage setup.
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
IS_POSTGRES = bool(DATABASE_URL)

if IS_POSTGRES:
    import psycopg2
    import psycopg2.extras

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("fitpulse")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Only used when IS_POSTGRES is False (local dev, or Vercel without a DB
# attached yet). DB_PATH can be overridden directly via an env var on any host.
if os.environ.get("DB_PATH"):
    DB_PATH = os.environ["DB_PATH"]
elif os.environ.get("VERCEL"):
    DB_PATH = os.path.join(tempfile.gettempdir(), "fitpulse.db")
else:
    DB_PATH = os.path.join(BASE_DIR, "fitpulse.db")


def now_str() -> str:
    """UTC timestamp as a plain string — stored identically whether the
    row lives in SQLite or Postgres, so every existing strptime() call in
    this file keeps working unchanged either way."""
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.environ.get("FLASK_SECRET_KEY", secrets.token_hex(32))

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

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9]{8,15}$")

# --- Payments (Razorpay) ---
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")


def get_razorpay_client():
    if not razorpay:
        return None
    if not RAZORPAY_KEY_ID or not RAZORPAY_KEY_SECRET:
        return None
    return razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))


def verify_razorpay_signature(order_id: str, payment_id: str, signature: str) -> bool:
    if not RAZORPAY_KEY_SECRET:
        return False
    generated = hmac.new(
        RAZORPAY_KEY_SECRET.encode("utf-8"),
        f"{order_id}|{payment_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(generated, signature)


def create_order_impl(plan: str, amount_paise: int, currency: str = "INR"):
    client = get_razorpay_client()
    if not client:
        return jsonify(
            ok=False,
            error="Payments aren't configured on the server yet (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET, or the razorpay package isn't installed).",
        ), 502

    if amount_paise < 100:
        return jsonify(ok=False, error="Minimum order amount is 100 paise."), 400

    try:
        order = client.order.create({
            "amount": amount_paise,
            "currency": currency,
            "receipt": f"user{session['user_id']}-{plan}-{int(time.time())}",
            "notes": {"user_id": str(session["user_id"]), "plan": plan},
        })
    except Exception as exc:
        logger.error("Razorpay order creation failed: %s", exc)
        msg = str(exc)
        if "Authentication" in msg or "auth" in msg.lower():
            msg = "Razorpay test auth failed. Please confirm that the key pair in .env is valid for the current Razorpay account and is being used from a secure HTTPS origin."
        return jsonify(ok=False, error=f"Could not start checkout: {msg}"), 502

    return jsonify(
        ok=True,
        requires_payment=True,
        payment_method="razorpay",
        razorpay_key_id=RAZORPAY_KEY_ID,
        order={"id": order["id"], "amount": order["amount"], "currency": order["currency"]},
        plan=plan,
    )


from werkzeug.exceptions import HTTPException


@app.errorhandler(Exception)
def handle_unexpected_error(e):
    """
    Never let an unhandled exception fall through to Flask's default HTML
    error page — the frontend always expects JSON with an `ok` field. This
    is what was silently turning real server errors into a generic
    'Could not create account' / 'Could not sign in.' message in the UI.
    Normal HTTP errors (404, etc.) pass through unchanged.
    """
    if isinstance(e, HTTPException):
        return jsonify(ok=False, error=e.description), e.code
    logger.error("Unhandled error on %s %s:\n%s", request.method, request.path, traceback.format_exc())
    return jsonify(ok=False, error=f"Server error: {e}"), 500

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

class _DbAdapter:
    """Lets every existing query in this file keep using '?' placeholders
    and .execute(sql, params) -> cursor with .fetchone()/.fetchall(),
    whether the underlying connection is sqlite3 or psycopg2."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        if IS_POSTGRES:
            cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql.replace("?", "%s"), params)
            return cur
        return self._conn.execute(sql, params)

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_db():
    if "db" not in g:
        if IS_POSTGRES:
            conn = psycopg2.connect(DATABASE_URL)
        else:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
        g.db = _DbAdapter(conn)
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


SCHEMA_POSTGRES = """
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        identifier TEXT UNIQUE NOT NULL,
        identifier_type TEXT NOT NULL,
        name TEXT,
        age INTEGER,
        weight_kg REAL,
        height_cm REAL,
        gender TEXT,
        activity_level TEXT DEFAULT 'moderate',
        goal TEXT DEFAULT 'maintain',
        country TEXT DEFAULT 'IN',
        plan TEXT DEFAULT 'free',
        password_hash TEXT,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
        id SERIAL PRIMARY KEY,
        identifier TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        verified INTEGER DEFAULT 0,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workout_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        exercise_name TEXT,
        category TEXT,
        duration_sec INTEGER,
        calories REAL,
        logged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS food_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        food_name TEXT NOT NULL,
        calories REAL NOT NULL,
        protein_g REAL DEFAULT 0,
        carbs_g REAL DEFAULT 0,
        fat_g REAL DEFAULT 0,
        logged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan TEXT NOT NULL,
        price REAL,
        currency TEXT,
        started_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_stats (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        xp INTEGER DEFAULT 0,
        streak_count INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        last_checkin_date TEXT,
        freeze_available INTEGER DEFAULT 2,
        freeze_month TEXT
    );

    CREATE TABLE IF NOT EXISTS user_unlocks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        unlock_id TEXT NOT NULL,
        unlocked_at TEXT
    );
"""

SCHEMA_SQLITE = """
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
        password_hash TEXT,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        verified INTEGER DEFAULT 0,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workout_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        exercise_name TEXT,
        category TEXT,
        duration_sec INTEGER,
        calories REAL,
        logged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS food_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        food_name TEXT NOT NULL,
        calories REAL NOT NULL,
        protein_g REAL DEFAULT 0,
        carbs_g REAL DEFAULT 0,
        fat_g REAL DEFAULT 0,
        logged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan TEXT NOT NULL,
        price REAL,
        currency TEXT,
        started_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_stats (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        xp INTEGER DEFAULT 0,
        streak_count INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        last_checkin_date TEXT,
        freeze_available INTEGER DEFAULT 2,
        freeze_month TEXT
    );

    CREATE TABLE IF NOT EXISTS user_unlocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        unlock_id TEXT NOT NULL,
        unlocked_at TEXT
    );
"""


def init_db():
    if IS_POSTGRES:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        cur.execute(SCHEMA_POSTGRES)
        conn.commit()
        conn.close()
        return

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA_SQLITE)
    try:
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# OTP delivery
# ---------------------------------------------------------------------------

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
    if id_type == "phone" and USE_TWILIO:
        return send_sms_otp(identifier, code)
    return send_email_otp(identifier, code)


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

def _serialize_user(user_row):
    user = dict(user_row)
    user.pop("password_hash", None)
    return user


@app.get("/api/me")
def get_current_user():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
    if not user:
        session.clear()
        return jsonify(ok=False, error="User not found."), 401

    return jsonify(ok=True, user=_serialize_user(user))


@app.post("/api/auth/register")
def register_user():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    name = (data.get("name") or email.split("@", 1)[0]).strip()

    if not EMAIL_RE.match(email):
        return jsonify(ok=False, error="Enter a valid email address."), 400
    if len(password) < 6:
        return jsonify(ok=False, error="Password must be at least 6 characters."), 400

    db = get_db()
    existing = db.execute("SELECT * FROM users WHERE identifier=?", (email,)).fetchone()
    if existing and existing["password_hash"]:
        return jsonify(ok=False, error="An account with that email already exists."), 409

    password_hash = generate_password_hash(password)
    if existing:
        db.execute(
            "UPDATE users SET name=?, password_hash=? WHERE id=?",
            (name, password_hash, existing["id"]),
        )
        user_id = existing["id"]
    elif IS_POSTGRES:
        cur = db.execute(
            "INSERT INTO users (identifier, identifier_type, name, password_hash, created_at) "
            "VALUES (?, 'email', ?, ?, ?) RETURNING id",
            (email, name, password_hash, now_str()),
        )
        user_id = cur.fetchone()["id"]
    else:
        cur = db.execute(
            "INSERT INTO users (identifier, identifier_type, name, password_hash, created_at) VALUES (?, 'email', ?, ?, ?)",
            (email, name, password_hash, now_str()),
        )
        user_id = cur.lastrowid

    db.commit()
    user = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    session["user_id"] = user_id
    return jsonify(ok=True, is_new_user=True, user=_serialize_user(user))


@app.post("/api/auth/login")
def login_user():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not EMAIL_RE.match(email):
        return jsonify(ok=False, error="Enter a valid email address."), 400

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE identifier=?", (email,)).fetchone()
    if not user:
        return jsonify(ok=False, error="Invalid email or password."), 401

    if not user["password_hash"]:
        password_hash = generate_password_hash(password)
        db.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash, user["id"]))
        db.commit()
        user = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()

    if not check_password_hash(user["password_hash"], password):
        return jsonify(ok=False, error="Invalid email or password."), 401

    session["user_id"] = user["id"]
    return jsonify(ok=True, is_new_user=False, user=_serialize_user(user))


@app.post("/api/auth/request-otp")
def request_otp():
    data = request.get_json(force=True, silent=True) or {}
    identifier = (data.get("identifier") or "").strip()

    if EMAIL_RE.match(identifier):
        id_type = "email"
    elif PHONE_RE.match(identifier):
        id_type = "phone"
    else:
        return jsonify(ok=False, error="Enter a valid email or phone number."), 400

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
        "INSERT INTO otp_codes (identifier, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (identifier, code_hash, expires_at, now_str()),
    )
    db.commit()

    sent, info = send_otp(identifier, id_type, code)
    if not sent:
        # Credentials not set up yet: tell the developer clearly instead of
        # silently pretending it worked. Never expose the raw code to the client.
        return jsonify(
            ok=False,
            error=f"Could not send code ({info}). Add real SMTP/Twilio credentials in .env.",
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
            "INSERT INTO users (identifier, identifier_type, created_at) VALUES (?, ?, ?)",
            (identifier, id_type, now_str()),
        )
        db.commit()
        user = db.execute("SELECT * FROM users WHERE identifier=?", (identifier,)).fetchone()
        is_new = True
    else:
        is_new = False

    session["user_id"] = user["id"]
    return jsonify(ok=True, is_new_user=is_new, user=dict(user))


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
            "INSERT INTO users (identifier, identifier_type, name, created_at) VALUES (?, 'email', ?, ?)",
            (email, info.get("name", ""), now_str()),
        )
        db.commit()
        user = db.execute("SELECT * FROM users WHERE identifier=?", (email,)).fetchone()

    session["user_id"] = user["id"]
    return jsonify(ok=True, user=dict(user))


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
            {"name": "Jumping Jacks", "duration": 45, "rest": 15, "met": 8.0, "muscles": ["shoulders", "quads", "calves", "abs"], "equipment": "Bodyweight"},
            {"name": "High Knees", "duration": 40, "rest": 20, "met": 8.5, "muscles": ["quads", "hamstrings", "calves", "abs"], "equipment": "Bodyweight"},
            {"name": "Mountain Climbers", "duration": 40, "rest": 20, "met": 8.0, "muscles": ["abs", "obliques", "shoulders", "quads"], "equipment": "Bodyweight"},
            {"name": "Burpees", "duration": 30, "rest": 30, "met": 10.0, "muscles": ["chest", "shoulders", "quads", "abs", "hamstrings", "calves"], "equipment": "Bodyweight"},
            {"name": "Jump Rope", "duration": 60, "rest": 20, "met": 11.0, "muscles": ["calves", "quads", "shoulders", "forearms"], "equipment": "Jump rope"},
        ],
    },
    "strength": {
        "label": "Strength",
        "color": "#8B7BFF",
        "items": [
            {"name": "Push-ups", "duration": 40, "rest": 20, "met": 6.0, "muscles": ["chest", "shoulders", "triceps", "abs"], "equipment": "Bodyweight"},
            {"name": "Squats", "duration": 45, "rest": 15, "met": 5.5, "muscles": ["quads", "hamstrings", "glutes"], "equipment": "Barbell / bodyweight"},
            {"name": "Lunges", "duration": 40, "rest": 20, "met": 5.0, "muscles": ["quads", "hamstrings", "glutes"], "equipment": "Dumbbells / bodyweight"},
            {"name": "Plank", "duration": 60, "rest": 20, "met": 4.0, "muscles": ["abs", "obliques", "shoulders"], "equipment": "Bodyweight"},
            {"name": "Glute Bridges", "duration": 40, "rest": 15, "met": 4.5, "muscles": ["glutes", "hamstrings", "lower_back"], "equipment": "Barbell / bodyweight"},
        ],
    },
    "hiit": {
        "label": "HIIT",
        "color": "#C7F464",
        "items": [
            {"name": "Squat Jumps", "duration": 30, "rest": 30, "met": 9.5, "muscles": ["quads", "glutes", "calves"], "equipment": "Bodyweight"},
            {"name": "Skater Hops", "duration": 30, "rest": 30, "met": 9.0, "muscles": ["quads", "glutes", "obliques", "calves"], "equipment": "Bodyweight"},
            {"name": "Tuck Jumps", "duration": 25, "rest": 35, "met": 10.0, "muscles": ["quads", "calves", "abs"], "equipment": "Bodyweight"},
            {"name": "Sprint in Place", "duration": 30, "rest": 30, "met": 11.5, "muscles": ["quads", "hamstrings", "calves"], "equipment": "Bodyweight"},
        ],
    },
    "yoga": {
        "label": "Yoga & Mobility",
        "color": "#6FD6C4",
        "items": [
            {"name": "Sun Salutation", "duration": 60, "rest": 10, "met": 3.0, "muscles": ["shoulders", "abs", "hamstrings", "quads"], "equipment": "Yoga mat"},
            {"name": "Downward Dog", "duration": 45, "rest": 10, "met": 2.5, "muscles": ["shoulders", "hamstrings", "calves", "upper_back"], "equipment": "Yoga mat"},
            {"name": "Warrior II", "duration": 45, "rest": 10, "met": 2.8, "muscles": ["quads", "glutes", "shoulders", "obliques"], "equipment": "Yoga mat"},
            {"name": "Cat-Cow Stretch", "duration": 40, "rest": 10, "met": 2.3, "muscles": ["abs", "lower_back", "upper_back"], "equipment": "Yoga mat"},
        ],
    },
    "stretching": {
        "label": "Cooldown & Stretch",
        "color": "#F2F0EA",
        "items": [
            {"name": "Hamstring Stretch", "duration": 30, "rest": 5, "met": 2.0, "muscles": ["hamstrings"], "equipment": "Bodyweight"},
            {"name": "Quad Stretch", "duration": 30, "rest": 5, "met": 2.0, "muscles": ["quads"], "equipment": "Bodyweight"},
            {"name": "Shoulder Stretch", "duration": 30, "rest": 5, "met": 1.8, "muscles": ["shoulders", "upper_back"], "equipment": "Bodyweight"},
            {"name": "Child's Pose", "duration": 45, "rest": 5, "met": 1.8, "muscles": ["lower_back", "lats", "shoulders"], "equipment": "Yoga mat"},
        ],
    },
    "chest": {
        "label": "Chest",
        "color": "#FF9166",
        "items": [
            {"name": "Incline Push-ups", "duration": 40, "rest": 20, "met": 5.0, "muscles": ["chest", "shoulders", "triceps"], "equipment": "Bench / bodyweight"},
            {"name": "Wide Push-ups", "duration": 40, "rest": 20, "met": 5.5, "muscles": ["chest", "shoulders"], "equipment": "Bodyweight"},
            {"name": "Chest Dips (chair)", "duration": 30, "rest": 25, "met": 6.0, "muscles": ["chest", "triceps", "shoulders"], "equipment": "Dip station / chair"},
            {"name": "Machine Chest Press", "duration": 45, "rest": 20, "met": 5.2, "muscles": ["chest", "shoulders", "triceps"], "equipment": "Chest press machine"},
        ],
    },
    "triceps": {
        "label": "Triceps",
        "color": "#FFC857",
        "items": [
            {"name": "Diamond Push-ups", "duration": 30, "rest": 25, "met": 5.5, "muscles": ["triceps", "chest"], "equipment": "Bodyweight"},
            {"name": "Tricep Dips", "duration": 35, "rest": 20, "met": 5.0, "muscles": ["triceps", "shoulders"], "equipment": "Dip station"},
            {"name": "Cable Pushdown", "duration": 35, "rest": 15, "met": 3.2, "muscles": ["triceps"], "equipment": "Cable machine"},
            {"name": "Close-Grip Push-ups", "duration": 35, "rest": 20, "met": 5.2, "muscles": ["triceps", "chest"], "equipment": "Bodyweight"},
        ],
    },
    "back": {
        "label": "Back",
        "color": "#5CC8FF",
        "items": [
            {"name": "Deadlift", "duration": 45, "rest": 25, "met": 5.4, "muscles": ["lower_back", "glutes", "hamstrings", "traps"], "equipment": "Barbell"},
            {"name": "Lat Pull Down", "duration": 40, "rest": 20, "met": 4.6, "muscles": ["lats", "biceps", "upper_back"], "equipment": "Cable machine"},
            {"name": "Pullups", "duration": 35, "rest": 25, "met": 5.0, "muscles": ["lats", "biceps", "upper_back", "forearms"], "equipment": "Pull-up bar"},
            {"name": "Barbell Row", "duration": 45, "rest": 20, "met": 4.8, "muscles": ["lats", "upper_back", "biceps"], "equipment": "Barbell"},
            {"name": "Dumbbell Row", "duration": 40, "rest": 20, "met": 4.2, "muscles": ["lats", "upper_back", "biceps"], "equipment": "Dumbbells"},
            {"name": "Superman Hold", "duration": 30, "rest": 15, "met": 3.0, "muscles": ["lower_back", "lats", "glutes"], "equipment": "Bodyweight"},
            {"name": "Reverse Snow Angels", "duration": 35, "rest": 15, "met": 3.2, "muscles": ["upper_back", "shoulders"], "equipment": "Bodyweight"},
            {"name": "Cable Row", "duration": 40, "rest": 20, "met": 4.4, "muscles": ["lats", "upper_back", "biceps"], "equipment": "Cable machine"},
        ],
    },
    "biceps": {
        "label": "Biceps",
        "color": "#C77DFF",
        "items": [
            {"name": "Resistance Band Curls", "duration": 35, "rest": 15, "met": 3.3, "muscles": ["biceps", "forearms"], "equipment": "Resistance band"},
            {"name": "Towel Curl (isometric)", "duration": 30, "rest": 15, "met": 2.8, "muscles": ["biceps"], "equipment": "Towel / bodyweight"},
            {"name": "Concentration Curl", "duration": 35, "rest": 15, "met": 3.0, "muscles": ["biceps"], "equipment": "Dumbbell"},
            {"name": "Cable Curl", "duration": 40, "rest": 20, "met": 4.0, "muscles": ["biceps", "forearms"], "equipment": "Cable machine"},
        ],
    },
    "shoulders": {
        "label": "Shoulders",
        "color": "#FF6FA8",
        "items": [
            {"name": "Pike Push-ups", "duration": 35, "rest": 20, "met": 5.5, "muscles": ["shoulders", "triceps"], "equipment": "Bodyweight"},
            {"name": "Arm Circles", "duration": 40, "rest": 10, "met": 2.5, "muscles": ["shoulders"], "equipment": "Bodyweight"},
            {"name": "Lateral Raise", "duration": 35, "rest": 15, "met": 3.0, "muscles": ["shoulders"], "equipment": "Cable machine / dumbbells"},
            {"name": "Smith Shoulder Press", "duration": 40, "rest": 20, "met": 4.8, "muscles": ["shoulders", "triceps"], "equipment": "Smith machine"},
        ],
    },
    "traps": {
        "label": "Traps",
        "color": "#7EE8B8",
        "items": [
            {"name": "Shrugs", "duration": 35, "rest": 15, "met": 3.0, "muscles": ["traps", "shoulders"], "equipment": "Barbell / dumbbells"},
            {"name": "Prone Y-Raises", "duration": 35, "rest": 15, "met": 3.2, "muscles": ["traps", "upper_back", "shoulders"], "equipment": "Bodyweight"},
            {"name": "Farmer's Carry", "duration": 40, "rest": 20, "met": 4.5, "muscles": ["traps", "forearms", "abs"], "equipment": "Dumbbells / kettlebells"},
            {"name": "Cable Shrug", "duration": 30, "rest": 15, "met": 3.3, "muscles": ["traps", "shoulders"], "equipment": "Cable machine"},
        ],
    },
    "forearms": {
        "label": "Forearms",
        "color": "#A0A8FF",
        "items": [
            {"name": "Wrist Curls", "duration": 35, "rest": 15, "met": 2.5, "muscles": ["forearms"], "equipment": "Barbell / dumbbell"},
            {"name": "Farmer's Carry Hold", "duration": 30, "rest": 20, "met": 3.5, "muscles": ["forearms", "traps"], "equipment": "Dumbbells / kettlebells"},
            {"name": "Towel Wring", "duration": 30, "rest": 10, "met": 2.2, "muscles": ["forearms"], "equipment": "Towel"},
            {"name": "Dead Hang", "duration": 25, "rest": 30, "met": 3.0, "muscles": ["forearms", "lats", "shoulders"], "equipment": "Pull-up bar"},
        ],
    },
    "abs": {
        "label": "Abs",
        "color": "#FFE066",
        "items": [
            {"name": "Crunches", "duration": 40, "rest": 15, "met": 4.0, "muscles": ["abs"], "equipment": "Bodyweight"},
            {"name": "Bicycle Crunches", "duration": 35, "rest": 20, "met": 5.0, "muscles": ["abs", "obliques"], "equipment": "Bodyweight"},
            {"name": "Cable Crunch", "duration": 40, "rest": 20, "met": 4.5, "muscles": ["abs"], "equipment": "Cable machine"},
            {"name": "Russian Twists", "duration": 35, "rest": 15, "met": 4.5, "muscles": ["abs", "obliques"], "equipment": "Medicine ball / bodyweight"},
        ],
    },
}


def current_user_plan():
    if "user_id" not in session:
        return "free"
    row = get_db().execute("SELECT plan FROM users WHERE id=?", (session["user_id"],)).fetchone()
    return row["plan"] if row else "free"


# ---------------------------------------------------------------------------
# Habit / streak / gamification
# ---------------------------------------------------------------------------
CHECKIN_XP = 5
WORKOUT_XP = 10
MONTHLY_STREAK_FREEZES = 2  # forgiveness credits — miss exactly 1 day and a freeze covers it

LEVEL_TIERS = [
    ("Bronze", 0),
    ("Silver", 100),
    ("Gold", 300),
    ("Platinum", 700),
]

# Consistency-first: most of these key off streaks/check-ins, not workout
# intensity, so beginners who just show up daily see real progress too.
UNLOCKABLES = [
    {"id": "first_workout", "name": "First Steps", "desc": "Complete your first workout", "type": "badge",
     "requirement": {"type": "workouts_total", "value": 1}},
    {"id": "streak_3", "name": "Getting Going", "desc": "3-day streak", "type": "badge",
     "requirement": {"type": "streak", "value": 3}},
    {"id": "streak_7", "name": "Week Warrior", "desc": "7-day streak", "type": "badge",
     "requirement": {"type": "streak", "value": 7}},
    {"id": "streak_30", "name": "Month Master", "desc": "30-day streak", "type": "badge",
     "requirement": {"type": "streak", "value": 30}},
    {"id": "xp_100", "name": "Rising Star", "desc": "Reach 100 XP (Silver)", "type": "badge",
     "requirement": {"type": "xp", "value": 100}},
    {"id": "xp_300", "name": "Dedicated", "desc": "Reach 300 XP (Gold)", "type": "badge",
     "requirement": {"type": "xp", "value": 300}},
    {"id": "xp_700", "name": "Unstoppable", "desc": "Reach 700 XP (Platinum)", "type": "badge",
     "requirement": {"type": "xp", "value": 700}},
    {"id": "workouts_20", "name": "Regular", "desc": "Log 20 workouts total", "type": "badge",
     "requirement": {"type": "workouts_total", "value": 20}},
]


def compute_level(xp: int) -> str:
    level = LEVEL_TIERS[0][0]
    for name, threshold in LEVEL_TIERS:
        if xp >= threshold:
            level = name
    return level


def get_or_create_stats(db, user_id):
    row = db.execute("SELECT * FROM user_stats WHERE user_id=?", (user_id,)).fetchone()
    if row:
        return dict(row)
    db.execute(
        "INSERT INTO user_stats (user_id, xp, streak_count, longest_streak, last_checkin_date, freeze_available, freeze_month) "
        "VALUES (?, 0, 0, 0, NULL, ?, NULL)",
        (user_id, MONTHLY_STREAK_FREEZES),
    )
    db.commit()
    row = db.execute("SELECT * FROM user_stats WHERE user_id=?", (user_id,)).fetchone()
    return dict(row)


def check_and_grant_unlocks(db, user_id, xp, streak):
    unlocked_rows = db.execute("SELECT unlock_id FROM user_unlocks WHERE user_id=?", (user_id,)).fetchall()
    already = {r["unlock_id"] for r in unlocked_rows}
    workouts_total = None
    newly_unlocked = []

    for item in UNLOCKABLES:
        if item["id"] in already:
            continue
        req = item["requirement"]
        met = False
        if req["type"] == "xp":
            met = xp >= req["value"]
        elif req["type"] == "streak":
            met = streak >= req["value"]
        elif req["type"] == "workouts_total":
            if workouts_total is None:
                workouts_total = db.execute(
                    "SELECT COUNT(*) AS c FROM workout_log WHERE user_id=?", (user_id,)
                ).fetchone()["c"]
            met = workouts_total >= req["value"]

        if met:
            db.execute(
                "INSERT INTO user_unlocks (user_id, unlock_id, unlocked_at) VALUES (?, ?, ?)",
                (user_id, item["id"], now_str()),
            )
            newly_unlocked.append(item)

    if newly_unlocked:
        db.commit()
    return newly_unlocked


@app.get("/api/exercises")
def get_exercises():
    if current_user_plan() != "free":
        return jsonify(ok=True, categories=EXERCISES)

    categories = {}
    for key, cat in EXERCISES.items():
        if key in FREE_CATEGORIES:
            categories[key] = cat
        else:
            categories[key] = {**cat, "items": [], "locked": True}
    return jsonify(ok=True, categories=categories)


@app.post("/api/log-workout")
def log_workout():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    data = request.get_json(force=True, silent=True) or {}
    user = get_db().execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
    weight = user["weight_kg"] or 70

    category = data.get("category")
    if current_user_plan() == "free" and category not in FREE_CATEGORIES:
        return jsonify(ok=False, error="This workout category needs Premium or Pro.", upgrade_required=True), 403

    met = float(data.get("met", 5))
    duration_sec = int(data.get("duration_sec", 0))
    # calories = MET * weight(kg) * hours
    calories = met * weight * (duration_sec / 3600)

    db = get_db()
    db.execute(
        """INSERT INTO workout_log (user_id, exercise_name, category, duration_sec, calories, logged_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (session["user_id"], data.get("exercise_name"), data.get("category"), duration_sec, calories, now_str()),
    )
    db.commit()

    stats = get_or_create_stats(db, session["user_id"])
    new_xp = (stats["xp"] or 0) + WORKOUT_XP
    db.execute("UPDATE user_stats SET xp=? WHERE user_id=?", (new_xp, session["user_id"]))
    db.commit()
    newly_unlocked = check_and_grant_unlocks(db, session["user_id"], new_xp, stats["streak_count"] or 0)

    return jsonify(
        ok=True,
        calories_burned=round(calories, 1),
        xp_gained=WORKOUT_XP,
        xp=new_xp,
        level=compute_level(new_xp),
        newly_unlocked=newly_unlocked,
    )


@app.get("/api/history")
def get_history():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    rows = get_db().execute(
        "SELECT * FROM workout_log WHERE user_id=? ORDER BY id DESC LIMIT 50",
        (session["user_id"],),
    ).fetchall()
    return jsonify(ok=True, history=[dict(r) for r in rows])


@app.post("/api/checkin")
def checkin():
    """Call once per day, right when the app opens — awards check-in XP
    before the person even starts a workout, and advances the streak.
    The client sends its own local calendar date (YYYY-MM-DD) since the
    server can't know the user's timezone; this keeps 'today' correct
    regardless of where the server runs."""
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    data = request.get_json(force=True, silent=True) or {}
    today_str = (data.get("local_date") or "").strip()
    try:
        today = date.fromisoformat(today_str)
    except ValueError:
        return jsonify(ok=False, error="Missing or invalid local_date (expected YYYY-MM-DD)."), 400

    db = get_db()
    stats = get_or_create_stats(db, session["user_id"])

    current_month = today_str[:7]
    freeze_available = stats["freeze_available"]
    freeze_month = stats["freeze_month"]
    if freeze_month != current_month:
        freeze_available = MONTHLY_STREAK_FREEZES
        freeze_month = current_month

    already_checked_in_today = stats["last_checkin_date"] == today_str
    streak = stats["streak_count"] or 0
    longest = stats["longest_streak"] or 0
    xp_gained = 0
    freeze_used = False

    if not already_checked_in_today:
        gap = None
        if stats["last_checkin_date"]:
            try:
                gap = (today - date.fromisoformat(stats["last_checkin_date"])).days
            except ValueError:
                gap = None

        if gap is None:
            streak = 1
        elif gap == 1:
            streak += 1
        elif gap == 2 and freeze_available > 0:
            # Missed exactly one day — a freeze forgives it, streak survives.
            freeze_available -= 1
            freeze_used = True
            streak += 1
        elif gap <= 0:
            streak = streak or 1  # clock skew safety net; don't crash the streak
        else:
            streak = 1  # missed 2+ days with no freeze left — resets

        longest = max(longest, streak)
        xp_gained = CHECKIN_XP

    new_xp = (stats["xp"] or 0) + xp_gained

    db.execute(
        """UPDATE user_stats SET xp=?, streak_count=?, longest_streak=?, last_checkin_date=?,
           freeze_available=?, freeze_month=? WHERE user_id=?""",
        (new_xp, streak, longest, today_str, freeze_available, freeze_month, session["user_id"]),
    )
    db.commit()

    newly_unlocked = check_and_grant_unlocks(db, session["user_id"], new_xp, streak)

    return jsonify(
        ok=True,
        already_checked_in_today=already_checked_in_today,
        xp_gained=xp_gained,
        xp=new_xp,
        level=compute_level(new_xp),
        streak=streak,
        longest_streak=longest,
        freeze_available=freeze_available,
        freeze_used=freeze_used,
        newly_unlocked=newly_unlocked,
    )


@app.get("/api/stats")
def get_stats():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    db = get_db()
    stats = get_or_create_stats(db, session["user_id"])
    unlocked_rows = db.execute(
        "SELECT unlock_id, unlocked_at FROM user_unlocks WHERE user_id=?", (session["user_id"],)
    ).fetchall()
    unlocked_ids = {r["unlock_id"]: r["unlocked_at"] for r in unlocked_rows}
    catalog = [
        {**item, "unlocked": item["id"] in unlocked_ids, "unlocked_at": unlocked_ids.get(item["id"])}
        for item in UNLOCKABLES
    ]
    return jsonify(
        ok=True,
        xp=stats["xp"] or 0,
        level=compute_level(stats["xp"] or 0),
        streak=stats["streak_count"] or 0,
        longest_streak=stats["longest_streak"] or 0,
        freeze_available=stats["freeze_available"] if stats["freeze_available"] is not None else MONTHLY_STREAK_FREEZES,
        unlockables=catalog,
    )


# ---------------------------------------------------------------------------
# Diet tracker — food database + food log
# ---------------------------------------------------------------------------
# Not exhaustive of every food on earth (no database is), but covers common
# veg, non-veg, dairy, grains, fruits, supplements and shakes so most people
# can log a real day of eating. Values are per the stated serving size.
FOOD_DATABASE = {
    "grains": {
        "label": "Grains & Carbs",
        "items": [
            {"name": "Rice (cooked)", "serving": "1 cup", "calories": 200, "protein_g": 4.3, "carbs_g": 44, "fat_g": 0.4},
            {"name": "Brown Rice (cooked)", "serving": "1 cup", "calories": 215, "protein_g": 5.0, "carbs_g": 45, "fat_g": 1.8},
            {"name": "Roti / Chapati", "serving": "1 piece", "calories": 120, "protein_g": 3.0, "carbs_g": 18, "fat_g": 3.5},
            {"name": "Oats (cooked)", "serving": "1 cup", "calories": 150, "protein_g": 5.9, "carbs_g": 27, "fat_g": 2.5},
            {"name": "Quinoa (cooked)", "serving": "1 cup", "calories": 220, "protein_g": 8.1, "carbs_g": 39, "fat_g": 3.6},
            {"name": "Bread (white)", "serving": "1 slice", "calories": 80, "protein_g": 2.7, "carbs_g": 15, "fat_g": 1.0},
            {"name": "Bread (whole wheat)", "serving": "1 slice", "calories": 70, "protein_g": 3.6, "carbs_g": 12, "fat_g": 1.0},
            {"name": "Pasta (cooked)", "serving": "1 cup", "calories": 220, "protein_g": 8.0, "carbs_g": 43, "fat_g": 1.3},
            {"name": "Potato (boiled)", "serving": "1 medium", "calories": 160, "protein_g": 4.0, "carbs_g": 37, "fat_g": 0.2},
            {"name": "Sweet Potato (boiled)", "serving": "1 medium", "calories": 180, "protein_g": 4.0, "carbs_g": 41, "fat_g": 0.1},
        ],
    },
    "legumes": {
        "label": "Legumes",
        "items": [
            {"name": "Dal / Lentils (cooked)", "serving": "1 cup", "calories": 230, "protein_g": 18, "carbs_g": 40, "fat_g": 0.8},
            {"name": "Chickpeas / Chana (cooked)", "serving": "1 cup", "calories": 270, "protein_g": 15, "carbs_g": 45, "fat_g": 4.2},
            {"name": "Rajma / Kidney Beans (cooked)", "serving": "1 cup", "calories": 225, "protein_g": 15, "carbs_g": 40, "fat_g": 0.9},
            {"name": "Tofu", "serving": "100 g", "calories": 145, "protein_g": 15.5, "carbs_g": 4.3, "fat_g": 8.7},
            {"name": "Paneer", "serving": "100 g", "calories": 265, "protein_g": 18, "carbs_g": 6, "fat_g": 20},
            {"name": "Soya Chunks (cooked)", "serving": "100 g", "calories": 150, "protein_g": 22, "carbs_g": 10, "fat_g": 1.5},
            {"name": "Sprouts", "serving": "1 cup", "calories": 30, "protein_g": 3.0, "carbs_g": 6, "fat_g": 0.2},
        ],
    },
    "vegetables": {
        "label": "Vegetables",
        "items": [
            {"name": "Mixed Vegetable Curry", "serving": "1 cup", "calories": 120, "protein_g": 3.5, "carbs_g": 15, "fat_g": 5.0},
            {"name": "Spinach / Palak (cooked)", "serving": "1 cup", "calories": 40, "protein_g": 3.5, "carbs_g": 6.5, "fat_g": 0.5},
            {"name": "Mixed Salad", "serving": "1 bowl", "calories": 50, "protein_g": 2.0, "carbs_g": 9, "fat_g": 0.5},
            {"name": "Broccoli (steamed)", "serving": "1 cup", "calories": 55, "protein_g": 3.7, "carbs_g": 11, "fat_g": 0.6},
        ],
    },
    "fruits": {
        "label": "Fruits",
        "items": [
            {"name": "Banana", "serving": "1 medium", "calories": 105, "protein_g": 1.3, "carbs_g": 27, "fat_g": 0.4},
            {"name": "Apple", "serving": "1 medium", "calories": 95, "protein_g": 0.5, "carbs_g": 25, "fat_g": 0.3},
            {"name": "Mango", "serving": "1 cup", "calories": 100, "protein_g": 1.4, "carbs_g": 25, "fat_g": 0.6},
            {"name": "Orange", "serving": "1 medium", "calories": 62, "protein_g": 1.2, "carbs_g": 15, "fat_g": 0.2},
            {"name": "Papaya", "serving": "1 cup", "calories": 60, "protein_g": 0.9, "carbs_g": 15, "fat_g": 0.2},
        ],
    },
    "dairy_eggs": {
        "label": "Dairy & Eggs",
        "items": [
            {"name": "Milk (whole)", "serving": "1 cup", "calories": 150, "protein_g": 8.0, "carbs_g": 12, "fat_g": 8.0},
            {"name": "Curd / Yogurt", "serving": "1 cup", "calories": 150, "protein_g": 8.5, "carbs_g": 11, "fat_g": 8.0},
            {"name": "Egg (boiled)", "serving": "1 large", "calories": 78, "protein_g": 6.3, "carbs_g": 0.6, "fat_g": 5.3},
            {"name": "Egg White", "serving": "1", "calories": 17, "protein_g": 3.6, "carbs_g": 0.2, "fat_g": 0.1},
            {"name": "Cheese Slice", "serving": "1 slice", "calories": 70, "protein_g": 4.0, "carbs_g": 1.0, "fat_g": 5.5},
            {"name": "Butter", "serving": "1 tbsp", "calories": 100, "protein_g": 0.1, "carbs_g": 0.0, "fat_g": 11.4},
            {"name": "Ghee", "serving": "1 tbsp", "calories": 120, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 13.6},
        ],
    },
    "non_veg": {
        "label": "Non-Veg",
        "items": [
            {"name": "Chicken Breast (cooked)", "serving": "100 g", "calories": 165, "protein_g": 31, "carbs_g": 0, "fat_g": 3.6},
            {"name": "Chicken Thigh (cooked)", "serving": "100 g", "calories": 209, "protein_g": 26, "carbs_g": 0, "fat_g": 11},
            {"name": "Mutton / Lamb", "serving": "100 g", "calories": 250, "protein_g": 25, "carbs_g": 0, "fat_g": 17},
            {"name": "Salmon (cooked)", "serving": "100 g", "calories": 208, "protein_g": 20, "carbs_g": 0, "fat_g": 13},
            {"name": "Fish (Rohu / Tilapia, cooked)", "serving": "100 g", "calories": 128, "protein_g": 26, "carbs_g": 0, "fat_g": 2.7},
            {"name": "Shrimp / Prawns (cooked)", "serving": "100 g", "calories": 99, "protein_g": 24, "carbs_g": 0.2, "fat_g": 0.3},
            {"name": "Beef (cooked)", "serving": "100 g", "calories": 250, "protein_g": 26, "carbs_g": 0, "fat_g": 17},
            {"name": "Pork (cooked)", "serving": "100 g", "calories": 242, "protein_g": 27, "carbs_g": 0, "fat_g": 14},
            {"name": "Bacon", "serving": "2 slices", "calories": 90, "protein_g": 6.0, "carbs_g": 0.3, "fat_g": 7.0},
            {"name": "Tuna (canned)", "serving": "100 g", "calories": 132, "protein_g": 29, "carbs_g": 0, "fat_g": 1.0},
        ],
    },
    "protein_supplements": {
        "label": "Protein & Supps",
        "items": [
            {"name": "Whey Protein Shake", "serving": "1 scoop", "calories": 120, "protein_g": 24, "carbs_g": 3, "fat_g": 1.5},
            {"name": "Whey Protein Isolate", "serving": "1 scoop", "calories": 110, "protein_g": 25, "carbs_g": 1.5, "fat_g": 0.5},
            {"name": "Mass Gainer Shake", "serving": "1 scoop", "calories": 480, "protein_g": 30, "carbs_g": 80, "fat_g": 4.0},
            {"name": "Casein Protein Shake", "serving": "1 scoop", "calories": 120, "protein_g": 24, "carbs_g": 3, "fat_g": 1.0},
            {"name": "Plant Protein Shake", "serving": "1 scoop", "calories": 110, "protein_g": 21, "carbs_g": 4, "fat_g": 2.0},
            {"name": "Protein Bar", "serving": "1 bar", "calories": 200, "protein_g": 20, "carbs_g": 21, "fat_g": 7.0},
            {"name": "BCAA", "serving": "1 serving", "calories": 5, "protein_g": 0, "carbs_g": 1.0, "fat_g": 0},
            {"name": "Creatine Monohydrate", "serving": "1 serving", "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0},
            {"name": "Pre-Workout", "serving": "1 scoop", "calories": 10, "protein_g": 0, "carbs_g": 2.0, "fat_g": 0},
            {"name": "Multivitamin", "serving": "1 serving", "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0},
            {"name": "Peanut Butter", "serving": "2 tbsp", "calories": 190, "protein_g": 7.0, "carbs_g": 6.0, "fat_g": 16},
            {"name": "Almonds", "serving": "10 pieces", "calories": 70, "protein_g": 2.6, "carbs_g": 2.5, "fat_g": 6.0},
            {"name": "Peanuts", "serving": "1/4 cup", "calories": 200, "protein_g": 9.0, "carbs_g": 6.0, "fat_g": 17},
        ],
    },
    "snacks_beverages": {
        "label": "Snacks",
        "items": [
            {"name": "Black Coffee", "serving": "1 cup", "calories": 2, "protein_g": 0.3, "carbs_g": 0, "fat_g": 0},
            {"name": "Tea with Milk", "serving": "1 cup", "calories": 40, "protein_g": 1.0, "carbs_g": 5.0, "fat_g": 1.5},
            {"name": "Green Tea", "serving": "1 cup", "calories": 2, "protein_g": 0, "carbs_g": 0.5, "fat_g": 0},
            {"name": "Soft Drink / Cola", "serving": "1 can", "calories": 140, "protein_g": 0, "carbs_g": 39, "fat_g": 0},
            {"name": "Fruit Juice", "serving": "1 cup", "calories": 110, "protein_g": 0.5, "carbs_g": 26, "fat_g": 0.2},
            {"name": "Biscuits", "serving": "2 pieces", "calories": 90, "protein_g": 1.3, "carbs_g": 14, "fat_g": 3.2},
            {"name": "Chips", "serving": "1 small pack", "calories": 150, "protein_g": 2.0, "carbs_g": 15, "fat_g": 10},
            {"name": "Chocolate", "serving": "40 g bar", "calories": 210, "protein_g": 2.5, "carbs_g": 24, "fat_g": 12},
            {"name": "Ice Cream", "serving": "1 scoop", "calories": 137, "protein_g": 2.3, "carbs_g": 16, "fat_g": 7.3},
            {"name": "Samosa", "serving": "1 piece", "calories": 260, "protein_g": 4.0, "carbs_g": 27, "fat_g": 15},
            {"name": "Pizza Slice", "serving": "1 slice", "calories": 285, "protein_g": 12, "carbs_g": 36, "fat_g": 10},
            {"name": "Burger", "serving": "1", "calories": 350, "protein_g": 15, "carbs_g": 33, "fat_g": 17},
            {"name": "French Fries", "serving": "1 medium", "calories": 365, "protein_g": 4.0, "carbs_g": 48, "fat_g": 17},
        ],
    },
}


@app.get("/api/foods")
def get_foods():
    if current_user_plan() != "free":
        return jsonify(ok=True, categories=FOOD_DATABASE, locked=False)
    locked = {key: {**cat, "items": [], "locked": True} for key, cat in FOOD_DATABASE.items()}
    return jsonify(ok=True, categories=locked, locked=True)


KNOWN_FOODS = {
    item["name"].strip().lower(): item
    for cat in FOOD_DATABASE.values()
    for item in cat["items"]
}


@app.post("/api/log-food")
def log_food():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    plan = current_user_plan()
    if plan == "free":
        return jsonify(ok=False, error="The diet tracker needs Premium or Pro.", upgrade_required=True), 403

    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("food_name") or "").strip()
    if not name:
        return jsonify(ok=False, error="Missing food name."), 400

    known = KNOWN_FOODS.get(name.lower())
    if known:
        # Always trust the database's own numbers for a recognized food,
        # never whatever the client sent, so no plan can log fake calories
        # for a real item.
        calories, protein_g, carbs_g, fat_g = known["calories"], known["protein_g"], known["carbs_g"], known["fat_g"]
    elif plan == "pro":
        try:
            calories = float(data.get("calories", 0))
        except (TypeError, ValueError):
            return jsonify(ok=False, error="Invalid calories."), 400
        protein_g = float(data.get("protein_g", 0) or 0)
        carbs_g = float(data.get("carbs_g", 0) or 0)
        fat_g = float(data.get("fat_g", 0) or 0)
    else:
        return jsonify(ok=False, error="Logging a custom food needs Pro.", upgrade_required=True), 403

    db = get_db()
    if IS_POSTGRES:
        cur = db.execute(
            """INSERT INTO food_log (user_id, food_name, calories, protein_g, carbs_g, fat_g, logged_at)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""",
            (session["user_id"], name, calories, protein_g, carbs_g, fat_g, now_str()),
        )
        new_id = cur.fetchone()["id"]
    else:
        cur = db.execute(
            """INSERT INTO food_log (user_id, food_name, calories, protein_g, carbs_g, fat_g, logged_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (session["user_id"], name, calories, protein_g, carbs_g, fat_g, now_str()),
        )
        new_id = cur.lastrowid
    db.commit()
    return jsonify(ok=True, id=new_id)


@app.get("/api/food-log")
def get_food_log():
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    rows = get_db().execute(
        "SELECT * FROM food_log WHERE user_id=? ORDER BY id DESC LIMIT 200",
        (session["user_id"],),
    ).fetchall()
    return jsonify(ok=True, log=[dict(r) for r in rows])


@app.delete("/api/food-log/<int:entry_id>")
def delete_food_log(entry_id):
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401
    db = get_db()
    row = db.execute(
        "SELECT id FROM food_log WHERE id=? AND user_id=?", (entry_id, session["user_id"])
    ).fetchone()
    if not row:
        return jsonify(ok=False, error="Not found."), 404
    db.execute("DELETE FROM food_log WHERE id=? AND user_id=?", (entry_id, session["user_id"]))
    db.commit()
    return jsonify(ok=True)


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

FREE_CATEGORIES = {"cardio", "strength", "hiit", "yoga", "stretching"}  # the original 5 — always free

BASE_PLANS = [
    {"id": "free", "name": "Free", "usd": 0, "period": "forever",
     "features": ["5 core workout categories", "Calorie/BMR/TDEE calculator", "Muscle-focus diagram", "Ads supported"]},
    {"id": "premium", "name": "Premium", "usd": 6.99, "period": "month",
     "features": ["Everything in Free", "All 13 workout categories (Chest, Back, Biceps, Abs & more)",
                  "Full diet & calorie tracker", "Progress history", "No ads"]},
    {"id": "pro", "name": "Pro", "usd": 59.99, "period": "year",
     "features": ["Everything in Premium", "Custom food logging", "Personalized AI workout plans",
                  "Priority support", "2 months free"]},
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
        rounded_price = round(local_price, 2)
        plans.append({
            **p,
            "amount": rounded_price,
            "price_display": f'{pricing["symbol"]}{rounded_price:,.0f}' if rounded_price >= 1 or rounded_price == 0
                              else f'{pricing["symbol"]}{rounded_price:.2f}',
            "currency": currency,
        })
    return jsonify(ok=True, country=country, plans=plans)


@app.post("/api/create-order")
def create_order():
    """
    Standard Razorpay web checkout order creation endpoint.
    Accepts the order amount in paise (minimum 100) and returns the
    order payload needed by the frontend checkout modal.
    """
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401

    data = request.get_json(force=True, silent=True) or {}
    amount = int(data.get("amount", 0) or 0)
    currency = (data.get("currency") or "INR").upper()
    receipt = data.get("receipt") or f"user{session['user_id']}-{int(time.time())}"

    if amount < 100:
        return jsonify(ok=False, error="Minimum order amount is 100 paise."), 400

    client = get_razorpay_client()
    if not client:
        return jsonify(
            ok=False,
            error="Payments aren't configured on the server yet (missing RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET, or the razorpay package isn't installed).",
        ), 502

    try:
        order = client.order.create({
            "amount": amount,
            "currency": currency,
            "receipt": receipt,
            "notes": {"user_id": str(session["user_id"])},
        })
    except Exception as exc:
        logger.error("Razorpay order creation failed: %s", exc)
        msg = str(exc)
        if "Authentication" in msg or "auth" in msg.lower():
            msg = "Razorpay test auth failed. Please confirm that the key pair in .env is valid for the current Razorpay account and is being used from a secure HTTPS origin."
        return jsonify(ok=False, error=f"Could not start checkout: {msg}"), 502

    return jsonify(
        ok=True,
        order_id=order["id"],
        amount=order["amount"],
        currency=order["currency"],
        key_id=RAZORPAY_KEY_ID,
    )


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

    # Free plan needs no payment — activate immediately.
    if plan == "free" or not price:
        db.execute(
            "INSERT INTO subscriptions (user_id, plan, price, currency, started_at) VALUES (?, ?, ?, ?, ?)",
            (session["user_id"], plan, price, currency, now_str()),
        )
        db.execute("UPDATE users SET plan=? WHERE id=?", (plan, session["user_id"]))
        db.commit()
        return jsonify(ok=True, message=f"Subscribed to {plan}.", requires_payment=False)

    amount_paise = int(round(float(price) * 100))
    return create_order_impl(plan=plan, amount_paise=amount_paise, currency=currency)


@app.post("/api/verify-payment")
def verify_payment():
    """
    Called by the frontend after Razorpay's checkout popup completes.
    Verifies the payment signature server-side (never trust the client)
    before recording the subscription and upgrading the user's plan.
    """
    if "user_id" not in session:
        return jsonify(ok=False, error="Not logged in."), 401

    data = request.get_json(force=True, silent=True) or {}
    order_id = data.get("razorpay_order_id")
    payment_id = data.get("razorpay_payment_id")
    signature = data.get("razorpay_signature")
    plan = data.get("plan")
    price = data.get("price", 0)
    currency = data.get("currency", "INR")

    if not (order_id and payment_id and signature and plan):
        return jsonify(ok=False, error="Missing payment details."), 400

    client = get_razorpay_client()
    if not client:
        return jsonify(ok=False, error="Payments aren't configured on the server."), 502

    if not verify_razorpay_signature(order_id, payment_id, signature):
        logger.warning("Razorpay signature verification failed for order %s", order_id)
        return jsonify(ok=False, error="Payment could not be verified."), 400

    db = get_db()
    db.execute(
        "INSERT INTO subscriptions (user_id, plan, price, currency, started_at) VALUES (?, ?, ?, ?, ?)",
        (session["user_id"], plan, price, currency, now_str()),
    )
    db.execute("UPDATE users SET plan=? WHERE id=?", (plan, session["user_id"]))
    db.commit()

    return jsonify(ok=True, message=f"Payment verified — subscribed to {plan}.")


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


@app.get("/api/debug-config")
def debug_config():
    """Safe to hit anytime — reports whether config is loaded, never the
    actual secret values. Remove this route once things are working if
    you'd rather not expose even this much on a public URL."""
    return jsonify(
        ok=True,
        razorpay_package_installed=razorpay is not None,
        razorpay_key_id_set=bool(RAZORPAY_KEY_ID),
        razorpay_key_id_prefix=(RAZORPAY_KEY_ID[:8] + "…") if RAZORPAY_KEY_ID else None,
        razorpay_key_secret_set=bool(RAZORPAY_KEY_SECRET),
        database_backend="postgres" if IS_POSTGRES else "sqlite",
        database_url_set=bool(DATABASE_URL),
        flask_secret_key_is_default=not bool(os.environ.get("FLASK_SECRET_KEY")),
        running_on_vercel=bool(os.environ.get("VERCEL")),
    )


init_db()  # idempotent (CREATE TABLE IF NOT EXISTS) — also runs when
           # Vercel imports this module, since /tmp starts empty each
           # cold start and the __main__ block below never executes there.

if __name__ == "__main__":
    app.run(debug=True, port=5000)
