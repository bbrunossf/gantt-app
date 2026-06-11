"""
FastAPI backend — ponte entre Trello e o banco do Gantt.

Endpoints:
  POST /import   — busca cards do Trello, faz upsert na DB, detecta órfãos
  POST /sync     — atualiza datas de um card específico no Trello
  GET  /health   — health check
"""

import os
import re
from datetime import date, datetime

import cuid2
import psycopg2
import psycopg2.pool
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv()

_cuid = cuid2.Cuid()


# ═══════════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════════

TRELLO_API_KEY    = os.environ["TRELLO_API_KEY"]
TRELLO_TOKEN      = os.environ["TRELLO_TOKEN"]
TRELLO_BOARD_ID   = os.environ["TRELLO_BOARD_ID"]
TRELLO_LIST_NAMES = os.environ.get("TRELLO_LIST_NAMES", "")
DATABASE_URL      = os.environ["DATABASE_URL"]
PLENA_DATABASE_URL = os.environ["PLENA_DATABASE_URL"]

# Nome do projeto padrão para tarefas importadas do Trello.
# Se não existir no banco, será criado automaticamente no primeiro /import.
DEFAULT_PROJECT_NAME = "Trello"

TRELLO_BASE = "https://api.trello.com/1"
AUTH_PARAMS = {"key": TRELLO_API_KEY, "token": TRELLO_TOKEN}

# ── Database connection pool ──────────────────────────────────────────────────

db_pool = psycopg2.pool.SimpleConnectionPool(1, 10, DATABASE_URL)
plena_pool = psycopg2.pool.SimpleConnectionPool(1, 5, PLENA_DATABASE_URL)



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
    start: str | None = None     # ISO  "2026-06-15"  ou  "2026-06-15T00:00:00"
    end: str | None = None
    name: str | None = None      # novo nome do card
    resource: str | None = None  # nome da lista de destino (move o card)



class SyncResponse(BaseModel):
    success: bool

class SyncProgressResponse(BaseModel):
    updated: int
    warnings: list[str]



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

#
# funções para importar projetos
# #

def _extract_cod_obra(description: str) -> str | None:
    """Extrai o código da obra da descrição via regex ID_OBRA = \\d{3}"""
    if not description:
        return None
    match = re.search(r"ID_OBRA = (\d{3})", description)
    return match.group(1) if match else None


def _extract_cod_obra_from_name(name: str) -> str | None:
    """Extrai código da obra dos 3 primeiros caracteres do nome, se forem dígitos."""
    if not name or len(name) < 3:
        return None
    prefix = name[:3]
    return prefix if prefix.isdigit() else None


def _get_or_create_project_by_cod_obra(cur, cod_obra: str) -> str:
    """
    Retorna o id do projeto associado ao codObra.
    Cria o projeto se ele ainda não existir (apenas um projeto por codObra).
    """
    cur.execute(
        'SELECT id FROM "Project" WHERE "codObra" = %s LIMIT 1',
        (cod_obra,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    project_id = _cuid.generate()

    cur.execute(
        'INSERT INTO "Project" (id, name, "codObra", "createdAt", "updatedAt") VALUES (%s, %s, %s, NOW(), NOW())',
        (project_id, f"Obra {cod_obra}", cod_obra),
    )
    return project_id


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

    project_id = _cuid.generate()
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

            # Extrai código da obra (descrição → fallback: nome)
            cod_obra = _extract_cod_obra(card.get("desc", ""))
            if not cod_obra:
                cod_obra = _extract_cod_obra_from_name(card["name"])

            trello_card_ids.add(card["id"])
            upsert.append({
                "trello_card_id": card["id"],
                "name":           card["name"],
                "start":          start,
                "end":            end,
                "resource":       lst["name"],
                "bar_label":      lst["name"],
                "cod_obra":       cod_obra,
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
                # Determina o projeto: se tem codObra, usa projeto específico; senão, default
                project_id = (
                    _get_or_create_project_by_cod_obra(cur, t["cod_obra"])
                    if t.get("cod_obra")
                    else default_project_id
                )

                cur.execute(
                    'SELECT id FROM "Task" WHERE "trelloCardId" = %s',
                    (t["trello_card_id"],),
                )
                exists = cur.fetchone()

                if exists:
                    cur.execute(
                        """
                        UPDATE "Task"
                            SET "projectId" = %s,
                                name       = %s,
                                start      = %s,
                                "end"      = %s,
                                resource   = %s,
                                "barLabel" = %s,
                                "trelloSyncStatus" = 'active',
                                "updatedAt" = NOW()
                            WHERE "trelloCardId" = %s
                        """,
                        (
                            project_id,
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
                            (id, "projectId", name, start, "end",
                                "barLabel", resource, "trelloCardId",
                                "trelloSyncStatus", "createdAt", "updatedAt")
                        VALUES
                            (%s, %s, %s, %s, %s,
                                %s, %s, %s,
                                'active', NOW(), NOW())
                        """,
                        (
                            _cuid.generate(), project_id,
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

@app.post("/sync-progress", response_model=SyncProgressResponse)
def sync_progress():
    """
    Lê a view vw_hras_obra do banco plena e atualiza o progresso
    dos projetos no banco do Gantt.

    Regras:
      - Relaciona projetos por Project.codObra = vw_hras_obra.cod_obra
      - progress = percentual_executado (já calculado pela view)
      - Valida se duração do projeto (dias) × 8h ≈ horas_previstas
    """
    warnings: list[str] = []
    updated = 0

    # 1. Lê dados da view no banco plena
    pc = plena_pool.getconn()
    try:
        with pc, pc.cursor() as cur:
            cur.execute("""
                SELECT cod_obra, total_horas_planejadas,
                total_horas_executadas, percentual_executado
                FROM vw_horas_obra
                """
            )
            rows = cur.fetchall()
            #print(f"valores obtidos na view: {rows}")
            print("ok, obtidos os valores na view")
    finally:
        plena_pool.putconn(pc)

    if not rows:
        return SyncProgressResponse(updated=0, warnings=["View vazia."])

    # 2. Para cada obra, atualiza o projeto correspondente
    gc = _get_db()
    try:
        with gc, gc.cursor() as cur:
            for cod_obra, horas_planejadas, horas_executadas, percentual in rows:
                progress = float(percentual or 0)

                # Atualiza o projeto pelo codObra
                cur.execute(
                    """
                    UPDATE "Project"
                       SET progress       = %s,
                           "plannedHours" = %s,
                           "actualHours"  = %s,
                           "updatedAt"    = NOW()
                     WHERE "codObra" = %s
                    """,
                    (progress, horas_planejadas, horas_executadas, cod_obra),
                )

                if cur.rowcount == 0:
                    warnings.append(
                        f"Obra '{cod_obra}' não encontrada na tabela Project."
                    )
                    continue

                updated += cur.rowcount

                # 3. Validação: duração do projeto vs horas previstas
                cur.execute(
                    """
                    SELECT p.name, MIN(t.start), MAX(t."end")
                    FROM "Project" p
                    JOIN "Task" t ON t."projectId" = p.id
                    WHERE p."codObra" = %s
                    GROUP BY p.name
                    """,
                    (cod_obra,),
                )
                proj = cur.fetchone()

                has_warning = False

                if proj and horas_planejadas and horas_planejadas > 0:
                    name, min_start, max_end = proj
                    if min_start and max_end:
                        dias_uteis = (max_end - min_start).days
                        horas_duracao = dias_uteis * 8

                        if horas_duracao > 0:
                            desvio = abs(horas_duracao - horas_planejadas) / horas_planejadas
                            if desvio > 0.2:
                                has_warning = True
                                warnings.append(
                                    f"'{name}': duração das tarefas "
                                    f"({dias_uteis}d × 8h = {horas_duracao}h) "
                                    f"diverge das horas previstas "
                                    f"({horas_planejadas}h) em {desvio:.0%}."
                                )
                elif not proj:
                    warnings.append(
                        f"Obra '{cod_obra}': projeto sem tarefas — "
                        f"não foi possível validar duração."
                    )

                # Atualiza o flag de warning
                cur.execute(
                    'UPDATE "Project" SET "hasHoursWarning" = %s WHERE "codObra" = %s',
                    (has_warning, cod_obra),
                )


    finally:
        _put_db(gc)

    return SyncProgressResponse(updated=updated, warnings=warnings)

# ═══════════════════════════════════════════════════════════════════════════════
# POST /sync
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/sync", response_model=SyncResponse)
def sync_to_trello(req: SyncRequest):
    """
    Atualiza os campos de um card no Trello.

    - 'end'      → campo nativo 'due'
    - 'start'    → campo nativo 'start'
    - 'name'     → campo nativo 'name'
    - 'resource' → move o card para a lista com o nome correspondente
    """
    params: dict = {}

    if req.start is not None:
        params["start"] = req.start
    if req.end is not None:
        params["due"] = req.end
    if req.name is not None:
        params["name"] = req.name

    # Move o card se o recurso (lista) foi alterado
    if req.resource is not None:
        all_lists = _trello_get(f"/boards/{TRELLO_BOARD_ID}/lists")
        target_list = next(
            (lst for lst in all_lists if lst["name"] == req.resource),
            None,
        )
        if target_list:
            params["idList"] = target_list["id"]

    if params:
        _trello_put(f"/cards/{req.trello_card_id}", **params)

    return SyncResponse(success=True)




# ═══════════════════════════════════════════════════════════════════════════════
# GET /health
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {"status": "ok"}
