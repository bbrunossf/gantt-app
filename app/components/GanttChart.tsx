import { useEffect, useRef, useState } from "react";
import Gantt from "frappe-gantt";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GanttViewMode = "Quarter Day" | "Half Day" | "Day" | "Week" | "Month";

export interface GanttTask {
  id: string;
  name: string;
  start: string;        // "YYYY-MM-DD"
  end: string;          // "YYYY-MM-DD"
  progress: number;     // 0–100
  dependencies?: string; // comma-separated task ids
  assignee?: string;
  custom_class?: string;
}

export interface GanttChartProps {
  tasks: GanttTask[];
  defaultView?: GanttViewMode;
  onDateChange?: (task: GanttTask, start: Date, end: Date) => Promise<void> | void;
  onProgressChange?: (task: GanttTask, progress: number) => Promise<void> | void;
  onTaskClick?: (task: GanttTask) => void;
  readOnly?: boolean;
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

  // Initialise / reinitialise when tasks change
  useEffect(() => {
    if (!containerRef.current || tasks.length === 0) return;

    // frappe-gantt mutates the container; clear it between renders
    containerRef.current.innerHTML = "";

    ganttRef.current = new Gantt(containerRef.current, tasks, {
      view_mode: viewMode,
      date_format: "YYYY-MM-DD",
      readonly: readOnly,
      popup_trigger: "click",

      on_click(task: GanttTask) {
        onTaskClick?.(task);
      },

      async on_date_change(task: GanttTask, start: Date, end: Date) {
        if (!onDateChange) return;
        setSaving(true);
        try {
          await onDateChange(task, start, end);
        } finally {
          setSaving(false);
        }
      },

      async on_progress_change(task: GanttTask, progress: number) {
        if (!onProgressChange) return;
        setSaving(true);
        try {
          await onProgressChange(task, progress);
        } finally {
          setSaving(false);
        }
      },
    });
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Change view without full reinit
  useEffect(() => {
    if (ganttRef.current) {
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
