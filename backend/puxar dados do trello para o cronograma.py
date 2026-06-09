# -*- coding: utf-8 -*-
"""
Created on Mon Jun  8 09:39:26 2026

@author: pichau
"""

import cuid  # pip install cuid2
from datetime import date
import datetime

# Retrieve Trello API key and token from Colab secrets
TRELLO_API_KEY = "38a02b7db3881952b6ce2bb8355e5e84"
TRELLO_API_TOKEN = "ATTA5d7d56189c8e06a4a4e2c8970a43e345350e39fb757b80a794ec84319899ef91BEB24BF3"
TRELLO_BOARD_ID = "69a1858cdc9a553a463c2b21" #board planejamento PLENA
db_conn_string = "postgresql://plena:123@10.0.0.6:5432/plena"

import json
import pandas as pd
from typing import Dict, Any
import psycopg2
from psycopg2.extras import RealDictCursor
import re
from trello import TrelloClient
from datetime import datetime, timedelta

# Initialize Trello client
client = TrelloClient(
    api_key=TRELLO_API_KEY,
    api_secret=TRELLO_API_TOKEN
)
print(f"Trello Client initialized. Please ensure `TRELLO_BOARD_ID` is set correctly: {TRELLO_BOARD_ID}")
board_name = client.get_board(TRELLO_BOARD_ID).name
print(f"Board Name: {board_name}")


def extract_cod_obra(description: str) -> str | None:
    """Extrai o código da obra da descrição"""
    if pd.isna(description):
        return None
    match = re.search(r"ID_OBRA = (\d{3})", description)
    return match.group(1) if match else None


def get_trello_card_data(board_id: str) -> pd.DataFrame:
    """Carrega dados dos cartões do Trello"""
    try:
        board = client.get_board(board_id)
    except Exception as e:
        print(f"Error accessing Trello board (ID: {board_id}): {e}")
        print("Please check your BOARD_ID and ensure your API key/token are correct and have access to the board.")
        return pd.DataFrame()

    data = []
    for tlist in board.list_lists():
        for card in tlist.list_cards():
            # Converter due_date para datetime se existir
            due_date = None
            if card.due_date:
                try:
                    due_date = datetime.fromisoformat(card.due_date.replace('Z', '+00:00'))
                except:
                    due_date = card.due_date if isinstance(card.due_date, datetime) else None
            
            data.append({
                'nome_lista': tlist.name,
                'titulo_card': card.name,
                'descricao_card': card.desc,
                'start_date_card': card.badges['start'] if card.badges['start'] is not None else "",
                'end_date_card': card.due_date,
                'due_date': due_date,  # Data de entrega processada
                'tarefa_completa': card.badges['dueComplete'] if card.badges['dueComplete'] is True else "",
            })


    return pd.DataFrame(data)


def carregar_dados_trello(board_id: str) -> pd.DataFrame:
    """Carrega e processa dados do Trello"""
    card_df = get_trello_card_data(board_id)
    
    # Remove tarefas concluídas
    card_df = card_df[card_df['tarefa_completa'] != True]
    
    card_df['cod_obra'] = card_df['descricao_card'].apply(extract_cod_obra)
    
    nomes = ['KARINA', 'EDUARDO', 'THADEU', 'CAROL', 'DAYANA', 'LEONARDO']
    final_df = card_df[['nome_lista', 'titulo_card', 'cod_obra', 'due_date']].dropna(subset=['cod_obra'])
    
    return final_df[final_df['nome_lista'].isin(nomes)]

# ── helpers ──────────────────────────────────────────────────────────────────

def parse_date(value) -> date | None:
    """Normaliza string ISO ou datetime para date."""
    if not value:
        return None
    if isinstance(value, date):
        return value if not hasattr(value, 'date') else value.date()
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).date()
    except Exception:
        return None


def get_trello_gantt_tasks(board_id: str, project_id: str) -> list[dict]:
    """
    Retorna lista de tarefas no formato do schema Task (frappe-gantt),
    apenas cards com start_date E due_date preenchidos.

    Cada item retornado:
        id, projectId, name, start, end, progress, barLabel, customClass
    """
    try:
        board = client.get_board(board_id)
    except Exception as e:
        print(f"Erro ao acessar board {board_id}: {e}")
        return []

    tasks = []

    for tlist in board.list_lists():
        for card in tlist.list_cards():
            start = parse_date(card.badges.get('start'))
            end   = parse_date(card.due_date)

            # Ignora cards sem as duas datas
            if not start or not end:
                continue

            # Garante ordem cronológica
            if end < start:
                start, end = end, start

            due_complete = card.badges.get('dueComplete', False)

            tasks.append({
                'id':          str(cuid.cuid()),   # gerado aqui; troque por lógica própria se quiser
                'projectId':   project_id,
                'name':        card.name,
                'start':       start,
                'end':         end,
                'progress':    100.0 if due_complete else 0.0,
                'barLabel':    tlist.name,          # nome da lista como label da barra
                'customClass': None,
                # metadados extras úteis na importação
                '_trello_card_id':  card.id,
                '_lista':           tlist.name,
                '_cod_obra':        extract_cod_obra(card.desc),
            })

    return tasks

# lista = get_trello_gantt_tasks(TRELLO_BOARD_ID, "teste")
# df = pd.DataFrame(lista)
#df.to_clipboard()

# ── importação para o PostgreSQL ─────────────────────────────────────────────

UPSERT_SQL = """
INSERT INTO "Task" (id, "projectId", name, start, "end", progress, "barLabel", "customClass", "createdAt", "updatedAt")
VALUES (%(id)s, %(projectId)s, %(name)s, %(start)s, %(end)s, %(progress)s, %(barLabel)s, %(customClass)s, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
    name        = EXCLUDED.name,
    start       = EXCLUDED.start,
    "end"       = EXCLUDED."end",
    progress    = EXCLUDED.progress,
    "barLabel"  = EXCLUDED."barLabel",
    "updatedAt" = NOW();
"""

def importar_tasks_para_db(tasks: list[dict], conn_string: str) -> None:
    if not tasks:
        print("Nenhuma tarefa para importar.")
        return

    conn = psycopg2.connect(conn_string)
    try:
        with conn, conn.cursor() as cur:
            rows = [
                {k: v for k, v in t.items() if not k.startswith('_')}
                for t in tasks
            ]
            cur.executemany(UPSERT_SQL, rows)
            print(f"{len(rows)} tarefa(s) importada(s) com sucesso.")
    finally:
        conn.close()


# ── execução ─────────────────────────────────────────────────────────────────

PROJECT_ID = "seu-project-id-aqui"   # id do registro em Project no banco

tasks = get_trello_gantt_tasks(TRELLO_BOARD_ID, PROJECT_ID)

print(f"\n{len(tasks)} tarefa(s) com start + due encontradas:\n")
for t in tasks:
    print(f"  [{t['_lista']}] {t['name']}  {t['start']} → {t['end']}  (obra: {t['_cod_obra']})")

# Descomente para importar:
# importar_tasks_para_db(tasks, db_conn_string)