import type { Project, Task } from "../../generated/prisma/client";

// ─── Tipo de entrada ───────────────────────────────────────────────────────────

type TaskWithDeps = Task & {
  dependencies: { predecessorId: string }[];
};

type ProjectWithTasks = Project & {
  tasks: TaskWithDeps[];
};

// ─── Tipo de saída (frappe-gantt) ─────────────────────────────────────────────

export interface GanttTask {
  id: string;
  name: string;
  start: string;         // "YYYY-MM-DD"
  end: string;           // "YYYY-MM-DD"
  progress: number;
  dependencies: string;  // comma-separated predecessor IDs (FS only)
  customClass: string;   // CSS class for the bar
  barLabel: string;      // label shown on the bar
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─── Mapeamento principal ─────────────────────────────────────────────────────

/**
 * Converte projetos e suas tarefas (flat) do Prisma para o formato
 * esperado pelo frappe-gantt, incluindo uma barra-fantasma por projeto.
 */
export function mapProjectsToGanttTasks(
  projects: ProjectWithTasks[]
): GanttTask[] {
  const result: GanttTask[] = [];

  for (const project of projects) {
    const tasks = project.tasks;

    if (tasks.length === 0) continue; // projeto sem tarefas: omite barra

    // ── Barra-fantasma do projeto ─────────────────────────────────────────
    const starts = tasks.map((t) => t.start.getTime());
    const ends = tasks.map((t) => t.end.getTime());

    const projectStart = new Date(Math.min(...starts));
    const projectEnd = new Date(Math.max(...ends));

    // Progresso do projeto = média ponderada pela duração das tarefas
    const totalDuration = tasks.reduce(
      (sum, t, i) => sum + (ends[i] - starts[i]),
      0
    );
    const weightedProgress = tasks.reduce((sum, t) => {
      const duration = t.end.getTime() - t.start.getTime();
      return sum + t.progress * duration;
    }, 0);
    const projectProgress =
      totalDuration > 0 ? Math.round(weightedProgress / totalDuration) : 0;

    result.push({
      id: `project-${project.id}`,
      name: project.name,
      start: formatDate(projectStart),
      end: formatDate(projectEnd),
      progress: projectProgress,
      dependencies: "",
      customClass: "gantt-project-bar",
      barLabel: "",
    });

    // ── Tarefas individuais (flat, sem hierarquia) ────────────────────────
    for (const task of tasks) {
      const predecessorIds = task.dependencies
        .map((d) => d.predecessorId)
        .join(",");

      result.push({
        id: task.id,
        name: task.name,
        start: formatDate(task.start),
        end: formatDate(task.end),
        progress: task.progress,
        dependencies: predecessorIds,
        customClass: task.customClass ?? "",
        barLabel: task.barLabel ?? "",
      });
    }
  }

  return result;
}
