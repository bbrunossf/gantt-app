// Frappe Gantt 1.2.x envia { task: {...} } no callback popup.
// Não confundir com as definições antigas de @types/frappe-gantt.
//
import { useCallback, useEffect, useRef, useState } from "react";
import Gantt from "frappe-gantt";
import type { GanttTask } from "../lib/taskMapper";
import TaskForm from "./TaskForm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GanttViewMode =
  | "Quarter Day"
  | "Half Day"
  | "Day"
  | "Week"
  | "Month";

export interface GanttChartProps {
  tasks: GanttTask[];
  defaultView?: GanttViewMode;
  onDateChange?: (
    task: GanttTask,
    start: Date,
    end: Date
  ) => Promise<void> | void;
  onProgressChange?: (
    task: GanttTask,
    progress: number
  ) => Promise<void> | void;
  onTaskClick?: (task: GanttTask) => void;
  /** Disparado quando o usuário cria uma dependência via popup */
   onAddDependency?: (
     taskId: string,
     predecessorId: string
   ) => Promise<void> | void;
   onTaskUpdated: () => Promise<void> | void;
  readOnly?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFrappeGanttTask(task: GanttTask) {
  return {
    id: task.id,
    // name: task.name,
    name: task.name || task.barLabel,
    start: task.start,
    end: task.end,
    progress: task.progress,
    dependencies: task.dependencies,
    custom_class: task.customClass,
  };
}

/** Gera um hash do conteúdo dos dados (datas + progresso), ignorando a ordem */
function computeDataHash(tasks: GanttTask[]): string {
  return tasks
    .map((t) => `${t.id}:${t.start}:${t.end}:${t.progress}`)
    .sort()
    .join("|");
}

// ─── Popup HTML builder ───────────────────────────────────────────────────────

type DepEventDetail = { taskId: string };


function buildPopupHtml(
  popupTask: GanttTask,
  matched: GanttTask,
  otherTaskCount: number
): string {
  const safeName = matched.name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `
    <div class="gantt-custom-popup">
      <div class="gantt-popup-header">
        <strong>${safeName}</strong>
      </div>
      <div class="gantt-popup-body">
        <div class="gantt-popup-row">
          <span class="gantt-popup-label">Início:</span>
          <span>${popupTask.start}</span>
        </div>
        <div class="gantt-popup-row">
          <span class="gantt-popup-label">Fim:</span>
          <span>${popupTask.end || "-"}</span>
        </div>

      </div>
      <div class="gantt-popup-footer">
        <button
          class="gantt-popup-dep-btn"
          type="button"
          onclick="document.dispatchEvent(new CustomEvent('gantt:add-dependency',{detail:{taskId:'${matched.id}'}}))"
        >
          + Dependência (${otherTaskCount})
        </button>

        <button
          class="gantt-popup-dep-btn"
          type="button"
          onclick="document.dispatchEvent(
            new CustomEvent(
              'gantt:edit-task',
              {detail:{taskId:'${matched.id}'}}
            )
          )"
        >
          Editar tarefa
        </button>
      </div>
    </div>
  `;
}



// ─── View toggle buttons ──────────────────────────────────────────────────────

const VIEW_MODES: GanttViewMode[] = ["Day", "Week", "Month"];

// ─── Component ────────────────────────────────────────────────────────────────

export default function GanttChart({
  tasks,
  defaultView = "Week",
  onDateChange,
  onProgressChange,
  onTaskClick,
  onAddDependency,
  onTaskUpdated,
  readOnly = false,
}: GanttChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ganttRef = useRef<InstanceType<typeof Gantt> | null>(null);
  const [viewMode, setViewMode] = useState<GanttViewMode>(defaultView);
  const [saving, setSaving] = useState(false);


  // ── Refs para callbacks (evita stale closure com instância persistente) ──

  const onDateChangeRef = useRef(onDateChange);
  onDateChangeRef.current = onDateChange;

  const onProgressChangeRef = useRef(onProgressChange);
  onProgressChangeRef.current = onProgressChange;

  const onTaskClickRef = useRef(onTaskClick);
  onTaskClickRef.current = onTaskClick;

  // ── Refs para o popup customizado ──

  const onAddDependencyRef = useRef(onAddDependency);
  onAddDependencyRef.current = onAddDependency;
  const onTaskUpdatedRef = useRef(onTaskUpdated);
  onTaskUpdatedRef.current = onTaskUpdated;


  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // ── Debounce para evitar chamadas repetidas durante arraste ──

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDateChangeRef = useRef<{
    task: GanttTask;
    start: Date;
    end: Date;
  } | null>(null);
  const pendingProgressChangeRef = useRef<{
    task: GanttTask;
    progress: number;
  } | null>(null);


  // ── Modal de dependência ─────────────────────────────────────────────────

  const [depPicker, setDepPicker] = useState<{
    taskId: string;
    taskName: string;
    predecessorId: string;
  } | null>(null);
  const [depSaving, setDepSaving] = useState(false);

  const openDepPicker = useCallback((taskId: string) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (task) {
      setDepPicker({ taskId, taskName: task.name, predecessorId: "" });
    }
  }, []);

  const otherTasks = tasks.filter(
    (t) => !t.id.startsWith("project-") && t.id !== depPicker?.taskId
  );
  const [editingTaskId, setEditingTaskId] =
    useState<string | null>(null);

  const [editingTask, setEditingTask] =
    useState<any | null>(null);

  const [loadingEditTask, setLoadingEditTask] =
    useState(false);

  // Escuta o evento customizado disparado pelo HTML do popup
  useEffect(() => {
    const handler = (e: Event) => {
      const { taskId } = (e as CustomEvent<DepEventDetail>).detail;
      openDepPicker(taskId);
    };
    document.addEventListener("gantt:add-dependency", handler);
    return () => document.removeEventListener("gantt:add-dependency", handler);
  }, [openDepPicker]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const { taskId } =
        (e as CustomEvent<{ taskId: string }>).detail;

      setLoadingEditTask(true);

      try {
        // const res = await fetch(`/api/tasks/${taskId}`);
        const res = await fetch(`/api/tasks?id=${taskId}`);

        if (!res.ok) {
          throw new Error("Erro ao carregar tarefa");
        }

        const task = await res.json();

        setEditingTask(task);
        setEditingTaskId(taskId);
      } catch (err) {
        console.error(err);
        alert("Não foi possível carregar a tarefa.");
      } finally {
        setLoadingEditTask(false);
      }
    };

    document.addEventListener(
      "gantt:edit-task",
      handler
    );

    return () =>
      document.removeEventListener(
        "gantt:edit-task",
        handler
      );
  }, []);

  // Limpa o timer de debounce ao desmontar
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);


  // ── Track IDs + data hash ───────────────────────────────────────────────

  const prevIds = useRef<string>("");
  const prevHash = useRef<string>("");

  // ── Initialize / reinitialize Gantt ──────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || tasks.length === 0) return;

    const currentIds = tasks
      .map((t) => t.id)
      .sort()
      .join(",");
    const currentHash = computeDataHash(tasks);

    // IDs e dados iguais → re-render inócuo, não faz nada
    if (
      ganttRef.current &&
      currentIds === prevIds.current &&
      currentHash === prevHash.current
    ) {
      return;
    }

    prevIds.current = currentIds;
    prevHash.current = currentHash;

    // Mudança estrutural (add/remove) ou de dados (datas/progresso) → recria
    containerRef.current.innerHTML = "";

    const frappeTasks = tasks.map(toFrappeGanttTask);

    // const minDate = new Date('2026-01-01');
    // const maxDate = new Date('2026-12-31');

    ganttRef.current = new Gantt(containerRef.current, frappeTasks, {
      view_mode: viewMode,
      language: 'pt-br',
      date_format: 'dd/mm/yy',
      readonly: readOnly,
      infinite_padding: false,
      padding: 6,
      container_height: 'auto',
      bar_height: 20, //min 10, max 100, padrao 30
      column_width: 80,
      lines: 'both',


      popup(ctx: any) {
        const popupTask = ctx.task;

        const matched = tasksRef.current.find(
          (t) => t.id === popupTask.id
        );

        if (!matched || matched.id.startsWith("project-")) {
          const safeName = (popupTask.name || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

          const horasGastasRow =
            matched &&
            (!matched.progress || matched.progress === 0 || matched.progress > 100) &&
            matched.actualHours != null
              ? `
                <div class="gantt-popup-row">
                  <span class="gantt-popup-label">Horas gastas:</span>
                  <span>${matched.actualHours}h</span>
                </div>
              `
              : "";

          return `
            <div class="gantt-custom-popup">
              <div class="gantt-popup-header">
                <strong>${safeName}</strong>
              </div>
              <div class="gantt-popup-body">
                <div class="gantt-popup-row">
                  <span class="gantt-popup-label">Início:</span>
                  <span>${popupTask.start}</span>
                </div>
                <div class="gantt-popup-row">
                  <span class="gantt-popup-label">Fim:</span>
                  <span>${popupTask.end || "-"}</span>
                </div>
                <div class="gantt-popup-row">
                  <span class="gantt-popup-label">Progresso:</span>
                  <span>${popupTask.progress}%</span>
                </div>
              ${horasGastasRow}
              </div>
            </div>
          `;
        }


        const others = tasksRef.current.filter(
          (t) => !t.id.startsWith("project-") && t.id !== matched.id
        );

        return buildPopupHtml(
          popupTask,
          matched,
          others.length
        );
      },



      on_click(task: GanttTask) {
        onTaskClickRef.current?.(task);
      },

      on_date_change(task: GanttTask, start: Date, end: Date) {
        if (!onDateChangeRef.current) return;

        pendingDateChangeRef.current = { task, start, end };

        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(async () => {
          const pending = pendingDateChangeRef.current;
          if (!pending) return;

          setSaving(true);                        // ← dentro do timeout → só dispara no save real

          try {
            await onDateChangeRef.current!(pending.task, pending.start, pending.end);

            const startStr = pending.start.toISOString().slice(0, 10);
            const endStr = pending.end.toISOString().slice(0, 10);

            const idx = tasksRef.current.findIndex((t) => t.id === pending.task.id);
            if (idx !== -1) {
              tasksRef.current[idx] = {
                ...tasksRef.current[idx],
                start: startStr,
                end: endStr,
              };
            }

            ganttRef.current?.update_task(pending.task.id, {
              start: startStr,
              end: endStr,
            });
          } finally {
            setSaving(false);
          }
        }, 1500);
      },


    });
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Change view without full reinit ──────────────────────────────────────

  useEffect(() => {
    if (ganttRef.current) {

      ganttRef.current.change_view_mode(viewMode);
    }
  }, [viewMode]);



  // ── Dependency submit handler ────────────────────────────────────────────

  async function handleDepSubmit() {
    if (!depPicker || !depPicker.predecessorId || !onAddDependencyRef.current)
      return;
    setDepSaving(true);
    try {
      await onAddDependencyRef.current(
        depPicker.taskId,
        depPicker.predecessorId
      );
      setDepPicker(null);
    } finally {
      setDepSaving(false);
    }
  }


  return (
    <div className="gantt-wrapper">
      {/* ── Toolbar ── */}
      <div className="gantt-toolbar">
        <div className="gantt-view-toggle">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode}
              className={`gantt-view-btn ${viewMode === mode ? "active" : ""}`}
              onClick={() => setViewMode(mode)}
              type="button"
            >
              {mode}
            </button>
          ))}
        </div>

        {saving && (
          <span className="gantt-saving-indicator" aria-live="polite">
            <span className="gantt-saving-dot" />
            Salvando…
          </span>
        )}
      </div>

      {/* ── Chart ── */}
      {tasks.length === 0 ? (
        <div className="gantt-empty">
          <p>Nenhuma tarefa cadastrada para exibir no Gantt.</p>
        </div>
      ) : (
        <div className="gantt-scroll-container">
          <div ref={containerRef} className="gantt-container" />
        </div>
      )}

      {/* ── Dependency Picker Modal ── */}
      {depPicker && (
        <div className="modal-overlay" onClick={() => setDepPicker(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">
                Adicionar dependência — {depPicker.taskName}
              </h2>
              <button
                className="modal-close"
                onClick={() => setDepPicker(null)}
                type="button"
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--color-text-2)" }}>
                Selecione a tarefa que deve ser concluída{" "}
                <strong>antes</strong> desta:
              </p>

              <div className="form-field">
                <label className="form-label" htmlFor="dep-predecessor">
                  Tarefa predecessora
                </label>
                <select
                  id="dep-predecessor"
                  className="form-input form-select"
                  value={depPicker.predecessorId}
                  onChange={(e) =>
                    setDepPicker((prev) =>
                      prev ? { ...prev, predecessorId: e.target.value } : null
                    )
                  }
                >
                  <option value="">Selecione uma tarefa…</option>
                  {otherTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.start} → {t.end})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setDepPicker(null)}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleDepSubmit}
                disabled={!depPicker.predecessorId || depSaving}
                type="button"
              >
                {depSaving ? "Salvando…" : "Adicionar dependência"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingTask && (
        <TaskForm
          task={editingTask}
          onCancel={() => {
            setEditingTask(null);
            setEditingTaskId(null);
          }}
          onSuccess={async () => {
            setEditingTask(null);
            setEditingTaskId(null);

            // Atualiza os dados do gráfico
            await onTaskUpdatedRef.current?.();
          }}
        />
      )}

    </div>
  );
}
