import type { Project, Task, TaskDependency } from "../../generated/prisma/client";

// ─── Tipos de entrada ─────────────────────────────────────────────────────────

type TaskWithRelations = Task & {
  children: TaskWithRelations[];
  predecessors: TaskDependency[];
};

type ProjectWithTasks = Project & {
  tasks: TaskWithRelations[];
};

// ─── Tipo de saída (frappe-gantt) ─────────────────────────────────────────────

export interface GanttTask {
  id: string;
  name: string;
  start: string;          // "YYYY-MM-DD"
  end: string;            // "YYYY-MM-DD"
  progress: number;
  dependencies: string;   // IDs separados por vírgula (somente FS)
  custom_class: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Coleta recursivamente todas as tarefas-folha de uma árvore.
 * Usado para calcular start/end da barra-fantasma do projeto.
 */
function collectAllDescendants(task: TaskWithRelations): TaskWithRelations[] {
  if (task.children.length === 0) return [task];
  return task.children.flatMap(collectAllDescendants);
}

/**
 * Ordena tarefas pelo campo WBS lexicograficamente
 * (ex: "1.1" < "1.2" < "1.10" usando comparação numérica por segmento).
 */
function sortByWbs(tasks: TaskWithRelations[]): TaskWithRelations[] {
  return [...tasks].sort((a, b) => {
    const partsA = a.wbs.split(".").map(Number);
    const partsB = b.wbs.split(".").map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

// ─── Mapeamento de uma tarefa (recursivo, até 3 níveis) ───────────────────────

const LEVEL_CLASSES = ["gantt-task-l1", "gantt-task-l2", "gantt-task-l3"];

function mapTask(
  task: TaskWithRelations,
  level: number,               // 0-based (0 = filho direto do projeto)
  result: GanttTask[]
): void {
  if (level >= 3) return;      // profundidade máxima: 3 níveis

  const fsPredecessorIds = task.predecessors
    .filter((d) => d.type === "FS")
    .map((d) => d.predecessorId)
    .join(",");

  result.push({
    id: task.id,
    name: task.name,
    start: formatDate(task.startDate),
    end: formatDate(task.endDate),
    progress: task.progress,
    dependencies: fsPredecessorIds,
    custom_class: LEVEL_CLASSES[level],
  });

  // Filhos ordenados por WBS
  const sortedChildren = sortByWbs(task.children);
  for (const child of sortedChildren) {
    mapTask(child, level + 1, result);
  }
}

// ─── Mapeamento principal ─────────────────────────────────────────────────────

export function mapProjectsToGanttTasks(
  projects: ProjectWithTasks[]
): GanttTask[] {
  const result: GanttTask[] = [];

  for (const project of projects) {
    // Apenas tarefas raiz (sem pai), ordenadas por WBS
    const rootTasks = sortByWbs(
      project.tasks.filter((t) => t.parentTaskId === null)
    );

    if (rootTasks.length === 0) continue; // projeto sem tarefas: omite barra

    // Calcula start/end da barra-fantasma a partir das tarefas-folha
    const allLeaves = rootTasks.flatMap(collectAllDescendants);
    const starts = allLeaves.map((t) => t.startDate.getTime());
    const ends = allLeaves.map((t) => t.endDate.getTime());
    const projectStart = new Date(Math.min(...starts));
    const projectEnd = new Date(Math.max(...ends));

    // Progresso do projeto = média ponderada pela duração das folhas
    const totalDuration = allLeaves.reduce((sum, t) => {
      return sum + (t.endDate.getTime() - t.startDate.getTime());
    }, 0);
    const weightedProgress = allLeaves.reduce((sum, t) => {
      const duration = t.endDate.getTime() - t.startDate.getTime();
      return sum + t.progress * duration;
    }, 0);
    const projectProgress =
      totalDuration > 0 ? Math.round(weightedProgress / totalDuration) : 0;

    // Barra-fantasma do projeto (bloqueada via CSS)
    result.push({
      id: `project-${project.id}`,
      name: project.name,
      start: formatDate(projectStart),
      end: formatDate(projectEnd),
      progress: projectProgress,
      dependencies: "",
      custom_class: "gantt-project-bar",
    });

    // Tarefas do projeto
    for (const task of rootTasks) {
      mapTask(task, 0, result);
    }
  }

  return result;
}
