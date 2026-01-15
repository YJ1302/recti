import os
from flask import Flask, request, jsonify
from supabase import create_client

app = Flask(__name__)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # keep only on backend
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

TABLE = "rectification_requests"

def verify_boleta_with_your_system(boleta: str, codigo: str, dni: str) -> bool:
    # TODO: replace with your real verification (SIGU/payment system)
    return bool(boleta and codigo and dni)

@app.post("/rectification/login")
def rectification_login():
    body = request.get_json(force=True)
    boleta = body.get("boleta", "").strip()
    codigo = body.get("codigo", "").strip()
    dni = body.get("dni", "").strip()

    if not verify_boleta_with_your_system(boleta, codigo, dni):
        return jsonify({"allowed": False, "error": "Invalid boleta/codigo/dni"}), 401

    # check status in supabase
    res = supabase.table(TABLE).select("status,message,final_data").eq("boleta", boleta).execute()
    row = res.data[0] if res.data else None

    if row and row.get("status") == "DONE":
        return jsonify({
            "allowed": False,
            "status": "DONE",
            "message": row.get("message") or "Already submitted.",
            "details": row.get("final_data")
        }), 403

    # create/update as pending/in_progress
    supabase.table(TABLE).upsert({
        "boleta": boleta,
        "codigo": codigo,
        "dni": dni,
        "status": "PENDING" if not row else (row.get("status") or "PENDING"),
    }, on_conflict="boleta").execute()

    return jsonify({"allowed": True, "status": "PENDING"})


@app.post("/rectification/submit")
def rectification_submit():
    body = request.get_json(force=True)
    boleta = body.get("boleta", "").strip()
    final_data = body.get("final_data", {})   # your complete rectification payload
    message = body.get("message", "Rectification submitted successfully.")

    # block overwrite if already DONE
    existing = supabase.table(TABLE).select("status").eq("boleta", boleta).execute()
    row = existing.data[0] if existing.data else None
    if row and row.get("status") == "DONE":
        return jsonify({"ok": False, "error": "Already submitted"}), 409

    supabase.table(TABLE).update({
        "final_data": final_data,
        "message": message,
        "status": "DONE"
    }).eq("boleta", boleta).execute()

    return jsonify({"ok": True, "status": "DONE"})
