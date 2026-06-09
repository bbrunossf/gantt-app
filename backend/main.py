"""
FastAPI backend — ponte entre Trello e o banco do Gantt.

Endpoints:
  POST /import   — busca cards do Trello, faz upsert na DB, detecta órfãos
  POST /sync     — atualiza datas de um card específico no Trello
  GET  /health   — health check
"""

import os
from datetime import date, datetime

import cuid
import psycopg2
import psycopg2.pool
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv()


# ═══════════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════════

TRELLO_API_KEY    = os.environ["TRELLO_API_KEY"]
TRELLO_TOKEN      = os.environ["TRELLO_TOKEN"]
TRELLO_BOARD_ID   = os.environ["TRELLO_BOARD_ID"]
TRELLO_LIST_NAMES = os.environ.get("TRELLO_LIST_NAMES", "")
DATABASE_URL      = os.environ["DATABASE_URL"]

# Nome do projeto padrão para tarefas importadas do Trello.
# Se não existir no banco, será criado automaticamente no primeiro /import.
DEFAULT_PROJECT_NAME = "Trello"

TRELLO_BASE = "https://api.trello.com/1"
AUTH_PARAMS = {"key": TRELLO_API_KEY, "token": TRELLO_TOKEN}

# ── Database connection pool ──────────────────────────────────────────────────

db_pool = psycopg2.pool.SimpleConnectionPool(1, 10, DATABASE_URL)


# ═══════════════════════════════════════════════════════════════════════════════
# FastAPI app
# ═══════════════════════════════════════════════════════════════════════════════

app = FastAPI(title="Trello ↔ Gantt Bridge")


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic models
# ═══════════════════════════════════════════════════════════════════════════════

class ImportResponse(BaseModel):
    created: int
    updated: int
    orphaned: int


class SyncRequest(BaseModel):
    trello_card_id: str
    start: str   # ISO  "2026-06-15"  ou  "2026-06-15T00:00:00"
    end: str


class SyncResponse(BaseModel):
    success: bool


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _get_db():
    return db_pool.getconn()


def _put_db(conn):
    db_pool.putconn(conn)


def _trello_get(path: str, **params) -> dict | list:
    """GET para a API REST do Trello."""
    resp = requests.get(
        f"{TRELLO_BASE}{path}",
        params={**AUTH_PARAMS, **params},
    )
    resp.raise_for_status()
    return resp.json()


def _trello_put(path: str, json_data: dict | None = None, **params) -> dict:
    """PUT para a API REST do Trello."""
    resp = requests.put(
        f"{TRELLO_BASE}{path}",
        params={**AUTH_PARAMS, **params},
        json=json_data or {},
    )
    resp.raise_for_status()
    return resp.json()


def _parse_date(value) -> date | None:
    """Normaliza string ISO ou datetime para ``date``."""
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except (ValueError, TypeError):
        return None

def _get_or_create_default_project(cur) -> str:
    """
    Retorna o id do projeto padrão (DEFAULT_PROJECT_NAME).
    Cria o projeto se ele ainda não existir.
    """
    cur.execute(
        'SELECT id FROM "Project" WHERE name = %s LIMIT 1',
        (DEFAULT_PROJECT_NAME,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    project_id = str(cuid.cuid())
    cur.execute(
        'INSERT INTO "Project" (id, name, "createdAt", "updatedAt") VALUES (%s, %s, NOW(), NOW())',
        (project_id, DEFAULT_PROJECT_NAME),
    )
    return project_id



# ═══════════════════════════════════════════════════════════════════════════════
# POST /import
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/trello-import", response_model=ImportResponse)
def import_from_trello():
    """
    Busca cards do Trello e faz upsert no banco.

    Regras de filtro:
      - Pertencem às listas definidas em TRELLO_LIST_NAMES (se configurado)
      - Possuem os campos 'start' (badge do Calendar Power-Up) E 'due' preenchidos
      - Não estão concluídos (badges.dueComplete = false)

    Regras de upsert:
      - Se trelloCardId já existe na DB → UPDATE
      - Se não existe → INSERT com novo cuid()

    Detecção de órfãos:
      - Tasks com trelloCardId que NÃO apareceram na resposta do Trello
        têm trelloSyncStatus atualizado para 'orphaned'
    """
    target_names = (
        set(n.strip() for n in TRELLO_LIST_NAMES.split(",") if n.strip())
        if TRELLO_LIST_NAMES else None
    )

    # 1. Coleta todas as listas do board
    all_lists = _trello_get(f"/boards/{TRELLO_BOARD_ID}/lists")

    trello_card_ids: set[str] = set()
    upsert: list[dict] = []

    for lst in all_lists:
        if target_names and lst["name"] not in target_names:
            continue

        cards = _trello_get(f"/lists/{lst['id']}/cards")

        for card in cards:
            start = _parse_date(card.get("badges", {}).get("start"))
            end   = _parse_date(card.get("due"))
            due_complete = card.get("badges", {}).get("dueComplete", False)

            # Descarta cards sem datas ou já concluídos
            if not start or not end or due_complete:
                continue

            # Garante ordem cronológica
            if end < start:
                start, end = end, start

            trello_card_ids.add(card["id"])
            upsert.append({
                "trello_card_id": card["id"],
                "name":           card["name"],
                "start":          start,
                "end":            end,
                "resource":       lst["name"],
                "bar_label":      lst["name"],
            })

    # 2. Upsert no PostgreSQL
    created = 0
    updated = 0

    conn = _get_db()
    try:
        with conn, conn.cursor() as cur:
            # Garante que o projeto padrão existe
            default_project_id = _get_or_create_default_project(cur)

            for t in upsert:
                cur.execute(
                    'SELECT id FROM "Task" WHERE "trelloCardId" = %s',
                    (t["trello_card_id"],),
                )
                exists = cur.fetchone()

                if exists:
                    cur.execute(
                        """
                        UPDATE "Task"
                           SET name       = %s,
                               start      = %s,
                               "end"      = %s,
                               resource   = %s,
                               "barLabel" = %s,
                               "trelloSyncStatus" = 'active',
                               "updatedAt" = NOW()
                         WHERE "trelloCardId" = %s
                        """,
                        (
                            t["name"], t["start"], t["end"],
                            t["resource"], t["bar_label"],
                            t["trello_card_id"],
                        ),
                    )
                    updated += 1
                else:
                    cur.execute(
                        """
                        INSERT INTO "Task"
                            (id, "projectId", name, start, "end", progress,
                             "barLabel", resource, "trelloCardId",
                             "trelloSyncStatus", "createdAt", "updatedAt")
                        VALUES
                            (%s, %s, %s, %s, %s, 0,
                             %s, %s, %s,
                             'active', NOW(), NOW())
                        """,
                        (
                            str(cuid.cuid()), default_project_id,
                            t["name"], t["start"], t["end"],
                            t["bar_label"], t["resource"], t["trello_card_id"],
                        ),
                    )
                    created += 1

            # 3. Marca órfãos (cards deletados/movidos do Trello)
            if trello_card_ids:
                cur.execute(
                    """
                    UPDATE "Task"
                       SET "trelloSyncStatus" = 'orphaned',
                           "updatedAt" = NOW()
                     WHERE "trelloCardId" IS NOT NULL
                       AND "trelloSyncStatus" = 'active'
                       AND "trelloCardId" != ALL(%s)
                    """,
                    (list(trello_card_ids),),
                )
            else:
                # Nenhum card retornou → todos viram órfãos
                cur.execute(
                    """
                    UPDATE "Task"
                       SET "trelloSyncStatus" = 'orphaned',
                           "updatedAt" = NOW()
                     WHERE "trelloCardId" IS NOT NULL
                       AND "trelloSyncStatus" = 'active'
                    """
                )
            orphaned = cur.rowcount

    finally:
        _put_db(conn)

    return ImportResponse(created=created, updated=updated, orphaned=orphaned)


# ═══════════════════════════════════════════════════════════════════════════════
# POST /sync
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/sync", response_model=SyncResponse)
def sync_to_trello(req: SyncRequest):
    """
    Atualiza as datas de um card no Trello.

    - 'end'  → campo nativo 'due' do card
    - 'start' → custom field 'date'/'data'/'início' do board
    """
    # 1. Atualiza data de término (due)
    _trello_put(f"/cards/{req.trello_card_id}", due=req.end)

    # 2. Atualiza data de início (custom field "date"/"data"/"início")
    custom_fields = _trello_get(f"/boards/{TRELLO_BOARD_ID}/customFields")
    date_field = next(
        (
            cf for cf in custom_fields
            if cf["name"].lower() in ("date", "data", "início", "inicio")
        ),
        None,
    )

    if date_field:
        field_id = date_field["id"]
        _trello_put(
            f"/cards/{req.trello_card_id}/customField/{field_id}/item",
            json_data={"value": {"date": req.start}},
        )

    return SyncResponse(success=True)


# ═══════════════════════════════════════════════════════════════════════════════
# GET /health
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {"status": "ok"}
