import { useLoaderData, useRevalidator } from "react-router";
import { prisma } from "../lib/prisma.server";
import { mapProjectsToGanttTasks } from "../lib/taskMapper";
import GanttChart from "../components/GanttChart";
import ProjectForm from "../components/ProjectForm";
import TaskForm from "../components/TaskForm";
import { useState } from "react";
import type { Route } from "./+types/gantt";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader(_: Route.LoaderArgs) {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      tasks: {
        where: { OR: [
           { trelloSyncStatus: null },      // tarefas manuais
           { trelloSyncStatus: "active" },  // tarefas sincronizadas ativas
         ]},
        orderBy: { createdAt: "asc" },
        include: {
          dependencies: {
            where: { type: "FS" },
            select: { predecessorId: true },
          },
        },
      },
    },
  });

  return mapProjectsToGanttTasks(projects);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GanttPage() {
  const tasks = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();

  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  // ── Callbacks do Gantt (arrastar / redimensionar) ─────────────────────────

  async function handleDateChange(
    task: { id: string },
    start: Date,
    end: Date
  ) {
    // Ignora a barra-fantasma do projeto
    if (task.id.startsWith("project-")) return;

    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: task.id,
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    });

    revalidate();
  }

  async function handleProgressChange(
    task: { id: string },
    progress: number
  ) {
    if (task.id.startsWith("project-")) return;

    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: task.id, progress }),
    });

    revalidate();
  }

  // -- Importação de dados do Trello
  async function handleTrelloImport() {
    setImporting(true);
    try {
      const res = await fetch("/api/trello-import", { method: "POST" });
      const result = await res.json();

      // 2. Sincroniza progresso dos projetos
      const progRes = await fetch("/api/sync-progress", { method: "POST" });
      const progData = await progRes.json();

      const msg = [
        `Importado: ${result.created} criadas, ${result.updated} atualizadas, ${result.orphaned} órfãs.`,
        `Progresso: ${progData.updated} projetos atualizados.`,
        ...(progData.warnings?.length
          ? [`\nAlertas:\n${progData.warnings.join("\n")}`]
          : []),
      ].join("\n");

      alert(msg);


      revalidate();
    } finally {
      setImporting(false);
    }
  }

  // ── Callback de dependência (popup do Gantt) ─────────────────────────────

  async function handleAddDependency(taskId: string, predecessorId: string) {
    // Encontra a task para obter as dependências atuais
    const task = tasks.find((t) => t.id === taskId);
    const existingDeps = task?.dependencies
      ? task.dependencies.split(",").filter(Boolean)
      : [];

    // Evita duplicata
    if (existingDeps.includes(predecessorId)) return;

    const mergedDeps = [...existingDeps, predecessorId];

    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, predecessorIds: mergedDeps }),
    });

    revalidate();
  }


  // ── Callbacks dos formulários ─────────────────────────────────────────────

  function handleFormSuccess() {
    setProjectFormOpen(false);
    setTaskFormOpen(false);
    revalidate();
  }

  return (
    <div className="gantt-page">
      {/* ── Header ── */}
      <header className="gantt-page-header">
        <h1 className="gantt-page-title">Cronograma da Carteira</h1>

        <div className="gantt-page-actions">
          <button className="btn btn-trello" onClick={handleTrelloImport} disabled={importing}>
            {importing ? "Importando..." : "Importar Trello"}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => setTaskFormOpen(true)}
            type="button"
          >
            + Tarefa
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setProjectFormOpen(true)}
            type="button"
          >
            + Projeto
          </button>
        </div>
      </header>

      {/* ── Gantt ── */}
      <main className="gantt-page-main">
        <GanttChart
          tasks={tasks}
          defaultView="Week"
          onDateChange={handleDateChange}
          onAddDependency={handleAddDependency}
          onTaskUpdated={() => revalidate()}
        />
      </main>

      {/* ── Modais ── */}
      {projectFormOpen && (
        <ProjectForm
          onSuccess={handleFormSuccess}
          onCancel={() => setProjectFormOpen(false)}
        />
      )}

      {taskFormOpen && (
        <TaskForm
          onSuccess={handleFormSuccess}
          onCancel={() => setTaskFormOpen(false)}
        />
      )}
    </div>
  );
}
