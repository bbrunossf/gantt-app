import { useEffect, useRef, useState } from "react";
import Gantt from "frappe-gantt";
import type { GanttTask } from "../lib/taskMapper";

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
  readOnly?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFrappeGanttTask(task: GanttTask) {
  return {
    id: task.id,
    // name: task.name,
    name: task.barLabel || task.name,
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

// ─── View toggle buttons ──────────────────────────────────────────────────────

const VIEW_MODES: GanttViewMode[] = ["Day", "Week", "Month"];

// ─── Component ────────────────────────────────────────────────────────────────

export default function GanttChart({
  tasks,
  defaultView = "Week",
  onDateChange,
  onProgressChange,
  onTaskClick,
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

  // ── Track IDs + data hash para detectar mudanças estruturais vs. dados ──

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

    const minDate = new Date('2026-01-01');
    const maxDate = new Date('2026-12-31');

    ganttRef.current = new Gantt(containerRef.current, frappeTasks, {
      view_mode: viewMode,
      date_format: "YYYY-MM-DD",
      readonly: readOnly,
      popup_trigger: "click",
      infinite_padding: false,


      on_click(task: GanttTask) {
        onTaskClickRef.current?.(task);
      },

      async on_date_change(task: GanttTask, start: Date, end: Date) {
        if (!onDateChangeRef.current) return;
        setSaving(true);
        try {
          await onDateChangeRef.current(task, start, end);
        } finally {
          setSaving(false);
        }
      },

      async on_progress_change(task: GanttTask, progress: number) {
        if (!onProgressChangeRef.current) return;
        setSaving(true);
        try {
          await onProgressChangeRef.current(task, progress);
        } finally {
          setSaving(false);
        }
      },
    });
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Change view without full reinit ──────────────────────────────────────

  useEffect(() => {
    if (ganttRef.current) {
      ganttRef.current.start = "2026-01-01";
      ganttRef.current.end = "2026-12-31";
      ganttRef.current.change_view_mode(viewMode);
    }
  }, [viewMode]);

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
    </div>
  );
}
